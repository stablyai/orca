import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from '../claude-accounts/live-pty-gate'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch
} from '../claude/claude-stream-json-connection'
import { refreshClaudeLoginViaCli } from './claude-cli-login-refresh'

vi.mock('./hidden-rate-limit-pty-cwd', () => ({
  resolveHiddenRateLimitPtyCwd: () => '/tmp/orca-test/rate-limit-pty-cwd'
}))

const authPreparation: ClaudeRuntimeAuthPreparation = {
  configDir: '/Users/test/managed/account-1',
  runtime: 'host',
  wslDistro: null,
  wslLinuxConfigDir: null,
  envPatch: { CLAUDE_CONFIG_DIR: '/Users/test/managed/account-1' },
  stripAuthEnv: true,
  provenance: 'managed:account-1'
}
const stillSelected = (): string => authPreparation.provenance

// The refresh refuses to launch anything but a real executable file.
const binDir = mkdtempSync(join(tmpdir(), 'orca-claude-login-refresh-'))
const claudeBin = join(binDir, 'claude')
writeFileSync(claudeBin, '#!/bin/sh\n', { mode: 0o755 })

function fakeConnect(getUsage: (handlers: ClaudeStreamJsonConnectionHandlers) => Promise<unknown>) {
  const seen: { launch?: ClaudeStreamJsonLaunch; closes: number; usageTimeout?: number } = {
    closes: 0
  }
  const connect = vi.fn(
    async (launch: ClaudeStreamJsonLaunch, handlers: ClaudeStreamJsonConnectionHandlers = {}) => {
      seen.launch = launch
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refresh only calls getUsage and close.
      return {
        getUsage: (options?: { timeoutMs?: number }) => {
          seen.usageTimeout = options?.timeoutMs
          return getUsage(handlers)
        },
        close: async () => {
          seen.closes += 1
          return true
        }
      } as unknown as ClaudeStreamJsonConnection
    }
  )
  return { connect, seen }
}

describe('refreshClaudeLoginViaCli', () => {
  afterEach(() => {
    endClaudeAuthSwitch()
  })

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true })
  })

  it('asks the account’s own Claude for usage in an isolated session-less child, then closes it', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-key')
    const { connect, seen } = fakeConnect(async () => ({ rate_limits_available: true }))

    await expect(
      refreshClaudeLoginViaCli({
        authPreparation,
        readCurrentAuthProvenance: stillSelected,
        networkProxySettings: { httpProxyUrl: 'http://proxy.test:8080' },
        connect,
        resolveCommand: () => claudeBin
      })
    ).resolves.toEqual({ kind: 'answered' })

    expect(seen.launch).toMatchObject({
      pathToClaudeCodeExecutable: claudeBin,
      cwd: '/tmp/orca-test/rate-limit-pty-cwd',
      options: {
        settingSources: ['user'],
        persistSession: false,
        strictMcpConfig: true,
        mcpServers: {},
        settings: { disableAllHooks: true }
      }
    })
    expect(seen.launch?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/Users/test/managed/account-1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false'
    })
    expect(seen.launch?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(Object.values(seen.launch?.env ?? {})).toContain('http://proxy.test:8080')
    expect(seen.usageTimeout).toBeGreaterThan(0)
    expect(seen.closes).toBe(1)
    vi.unstubAllEnvs()
  })

  it('reports a CLI without get_usage as unsupported', async () => {
    const { connect, seen } = fakeConnect(async () => {
      throw new Error('Unsupported control request subtype: get_usage')
    })

    await expect(
      refreshClaudeLoginViaCli({
        authPreparation,
        readCurrentAuthProvenance: stillSelected,
        connect,
        resolveCommand: () => claudeBin
      })
    ).resolves.toMatchObject({ kind: 'unsupported' })
    expect(seen.closes).toBe(1)
  })

  it('reports why the CLI exited before it answered', async () => {
    const { connect, seen } = fakeConnect(async (handlers) => {
      handlers.onFault?.(new Error('claude stream-json exited (code 1): accept the updated terms'))
      throw new Error('Query closed before response received')
    })

    await expect(
      refreshClaudeLoginViaCli({
        authPreparation,
        readCurrentAuthProvenance: stillSelected,
        connect,
        resolveCommand: () => claudeBin
      })
    ).resolves.toEqual({
      kind: 'failed',
      message: 'claude stream-json exited (code 1): accept the updated terms'
    })
    expect(seen.closes).toBe(1)
  })

  it('starts nothing when no runnable Claude binary was found', async () => {
    const { connect } = fakeConnect(async () => ({}))
    const notExecutable = join(binDir, 'claude-not-executable')
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 })

    // Windows has no execute bit, so a plain file counts as runnable there.
    const commands = ['claude', join(binDir, 'missing-claude'), binDir]
    if (process.platform !== 'win32') {
      commands.push(notExecutable)
    }
    for (const command of commands) {
      await expect(
        refreshClaudeLoginViaCli({
          authPreparation,
          readCurrentAuthProvenance: stillSelected,
          connect,
          resolveCommand: () => command
        })
      ).resolves.toEqual({
        kind: 'not-launched',
        message: `no runnable Claude CLI at ${command}`
      })
    }
    expect(connect).not.toHaveBeenCalled()
  })

  it('closes the child when the fetch is aborted mid-request', async () => {
    const controller = new AbortController()
    const { connect, seen } = fakeConnect(async () => {
      controller.abort()
      throw new Error('Query closed before response received')
    })

    await expect(
      refreshClaudeLoginViaCli({
        authPreparation,
        readCurrentAuthProvenance: stillSelected,
        connect,
        signal: controller.signal,
        resolveCommand: () => claudeBin
      })
    ).resolves.toMatchObject({ kind: 'failed' })
    expect(seen.closes).toBeGreaterThanOrEqual(1)
  })

  it('starts nothing when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { connect } = fakeConnect(async () => ({}))

    await expect(
      refreshClaudeLoginViaCli({
        authPreparation,
        readCurrentAuthProvenance: stillSelected,
        connect,
        signal: controller.signal
      })
    ).resolves.toMatchObject({ kind: 'not-started' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('starts nothing when aborted while an account switch settles', async () => {
    const controller = new AbortController()
    const { connect } = fakeConnect(async () => ({}))
    beginClaudeAuthSwitch()

    const outcome = refreshClaudeLoginViaCli({
      authPreparation,
      readCurrentAuthProvenance: stillSelected,
      connect,
      signal: controller.signal,
      resolveCommand: () => claudeBin
    })
    controller.abort()
    endClaudeAuthSwitch()

    await expect(outcome).resolves.toEqual({ kind: 'not-started', message: 'aborted' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('starts nothing when the switch it waited for selected another login', async () => {
    const { connect } = fakeConnect(async () => ({}))
    let selected = authPreparation.provenance
    beginClaudeAuthSwitch()

    const outcome = refreshClaudeLoginViaCli({
      authPreparation,
      readCurrentAuthProvenance: () => selected,
      connect,
      resolveCommand: () => claudeBin
    })
    // The user switched back to their own login; the runtime home now holds it.
    selected = 'system'
    endClaudeAuthSwitch()

    await expect(outcome).resolves.toEqual({
      kind: 'not-started',
      message: 'the selected Claude account changed'
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('starts nothing when the account changed before the refresh began', async () => {
    const { connect } = fakeConnect(async () => ({}))

    await expect(
      refreshClaudeLoginViaCli({
        authPreparation,
        readCurrentAuthProvenance: () => 'managed:account-2',
        connect,
        resolveCommand: () => claudeBin
      })
    ).resolves.toMatchObject({ kind: 'not-started' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('reports a connection that never started Claude as not started', async () => {
    const connect = vi.fn(async () => {
      throw new Error('query() returned without spawning a child')
    })

    await expect(
      refreshClaudeLoginViaCli({
        authPreparation,
        readCurrentAuthProvenance: stillSelected,
        connect,
        resolveCommand: () => claudeBin
      })
    ).resolves.toEqual({
      kind: 'not-started',
      message: 'query() returned without spawning a child'
    })
  })
})
