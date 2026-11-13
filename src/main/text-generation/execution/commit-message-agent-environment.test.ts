import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareLocalCommitMessageAgentEnv } from './commit-message-agent-environment'
import '../../codex-accounts/managed-homes/host-codex-managed-home-ownership'

const originalEnv = { ...process.env }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const tempDirs: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, originalEnv)
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeHome(): string {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  const dir = mkdtempSync(join(tmpdir(), 'orca-commit-env-'))
  tempDirs.push(dir)
  process.env.HOME = dir
  process.env.SHELL = '/bin/zsh'
  delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
  delete process.env.ORCA_PI_SOURCE_AGENT_DIR
  return dir
}

describe('prepareLocalCommitMessageAgentEnv', () => {
  it('isolates Claude generation inheritance before account overrides, including resolver fallbacks', async () => {
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', 'parent-socket')
    vi.stubEnv('CLAUDE_AGENT_SDK_VERSION', 'parent-sdk')
    vi.stubEnv('CLAUDE_CODE_HTTP_PROXY', 'http://user-proxy')
    for (const resolvers of [undefined, {}]) {
      const result = await prepareLocalCommitMessageAgentEnv('claude', resolvers)
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.env?.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
      expect(result.env?.CLAUDE_AGENT_SDK_VERSION).toBeUndefined()
      expect(result.env?.CLAUDE_CODE_HTTP_PROXY).toBe('http://user-proxy')
    }
    const configured = await prepareLocalCommitMessageAgentEnv('claude', {
      resolveBaseEnvironment: async () => ({
        CLAUDE_CODE_MESSAGING_SOCKET: 'shell-parent',
        CLAUDE_EFFORT: 'shell-effort',
        CLAUDE_CODE_HTTP_PROXY: 'http://shell-proxy',
        ANTHROPIC_AUTH_TOKEN: 'chosen-token'
      }),
      prepareForClaudeLaunch: async () => ({
        configDir: '/chosen/claude',
        envPatch: { CLAUDE_CONFIG_DIR: '/chosen/claude' },
        provenance: 'profile:test'
      })
    })
    expect(configured).toEqual({
      ok: true,
      env: {
        CLAUDE_CODE_HTTP_PROXY: 'http://shell-proxy',
        CLAUDE_CONFIG_DIR: '/chosen/claude',
        ANTHROPIC_AUTH_TOKEN: 'chosen-token'
      }
    })
  })

  it('hydrates OpenCode config dir from shell startup files for headless generation', async () => {
    const home = makeHome()
    delete process.env.OPENCODE_CONFIG_DIR
    writeFileSync(join(home, '.zshrc'), 'export OPENCODE_CONFIG_DIR="$HOME/company/opencode"\n')

    const result = await prepareLocalCommitMessageAgentEnv('opencode', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        OPENCODE_CONFIG_DIR: `${home}/company/opencode`
      })
    })
  })

  // STA-4422: failed managed-home preparation must not fall through to the user's real account while UI shows a managed account.

  it('strips a nested-Orca CODEX_HOME override when the launch resolves to the real home', async () => {
    process.env.CODEX_HOME = '/managed/runtime/home'
    process.env.ORCA_CODEX_HOME = '/managed/runtime/home'

    const result = await prepareLocalCommitMessageAgentEnv('codex', {
      prepareForCodexLaunch: () => null
    })

    expect(result.ok).toBe(true)
    const env = (result as { ok: true; env?: NodeJS.ProcessEnv }).env
    expect(env).toBeDefined()
    expect(env?.CODEX_HOME).toBeUndefined()
    expect(env?.ORCA_CODEX_HOME).toBeUndefined()
  })
})
