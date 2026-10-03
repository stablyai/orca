import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WindowsShortPath from '../windows/windows-short-path'

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn(),
  runCodexAppServerSession: vi.fn(),
  resolveWindowsShortPath: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.runProcess }))
vi.mock('./codex-app-server-session', () => ({
  runCodexAppServerSession: mocks.runCodexAppServerSession
}))
vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: () => '/opt/codex/bin/codex',
  withCliRuntimeOnPath: (_path: string, env: NodeJS.ProcessEnv) => env
}))
vi.mock('../windows/windows-short-path', async (importOriginal) => ({
  ...(await importOriginal<typeof WindowsShortPath>()),
  resolveWindowsShortPath: mocks.resolveWindowsShortPath
}))

import { deriveCodexHookFlagEntry } from './codex-hook-session-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import { buildCodexHookSessionFlag } from './codex-hook-session-flags'
import {
  createCodexHookFlagTable,
  getCodexHookFlagTablePath,
  readCodexHookFlagEntry
} from './codex-hook-flag-table'

/**
 * Codex's hooks/list answer: an approval in the flag (either spelling) reads
 * trusted unless `full` overrides it; `listed` drops events a Codex predates.
 */
function listingFor(
  command: string,
  flag: string,
  hashPrefix = 'sha256:',
  full: { trusted?: boolean; enabled?: boolean; interrupt?: 'unlisted' | 'untrusted' } = {}
): unknown {
  const approved = /state\s*=/.test(flag)
  return {
    data: [
      {
        hooks: CODEX_EVENTS.filter(
          (eventName) => eventName !== 'Interrupt' || full.interrupt !== 'unlisted'
        ).map((eventName) => {
          const label = CODEX_EVENT_LABEL[eventName]
          const trusted =
            approved &&
            (full.trusted ?? true) &&
            !(eventName === 'Interrupt' && full.interrupt === 'untrusted')
          return {
            key: `/<session-flags>/config.toml:${label}:0:0`,
            command,
            currentHash: `${hashPrefix}${label}`,
            trustStatus: trusted ? 'trusted' : 'untrusted',
            source: 'sessionFlags',
            enabled: approved ? (full.enabled ?? true) : true
          }
        })
      }
    ]
  }
}

const versions = new Map<string, string | null>()

function answerVersion(version: string | null, codex = '/opt/codex/bin/codex'): void {
  versions.set(codex, version)
}

function answerSession(
  respond: (command: string, flag: string) => unknown = (command, flag) => listingFor(command, flag)
): void {
  mocks.runCodexAppServerSession.mockImplementation(async (invocation, body) =>
    body({ request: async () => respond(hookCommand(), invocation.args[1]) })
  )
}

/** Derives for Orca's codex; resolves to the published entry or null. */
async function deriveEntry(
  codexPath = '/opt/codex/bin/codex',
  canPublish: () => boolean = () => true
) {
  return (await deriveCodexHookFlagEntry(codexPath, canPublish)).entry
}

function hookCommand(): string {
  return getManagedCommand(getManagedScriptPath())
}

function versionFile(version: string): string {
  return join(getCodexHookFlagTablePath(), `${version}.flag`)
}

describe('codex hook session trust', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-codex-hook-trust-table-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    // Why: publishing writes the hook script under ~/.orca.
    vi.stubEnv('HOME', join(userData, 'home'))
    vi.stubEnv('USERPROFILE', join(userData, 'home'))
    // Why: the table exists exactly while Codex hooks are on.
    createCodexHookFlagTable()
    versions.clear()
    mocks.runProcess.mockReset()
    mocks.runCodexAppServerSession.mockReset()
    mocks.runProcess.mockImplementation(async ({ program, args }) => {
      if (args[0] === '--help') {
        return { code: 0, stdout: 'Usage: codex [--no-daemon]', stderr: '', signal: null }
      }
      const version = versions.get(program) ?? null
      return version === null
        ? { code: 1, stdout: '', stderr: 'boom', signal: null, timedOut: false }
        : { code: 0, stdout: `${version}\n`, stderr: '', signal: null, timedOut: false }
    })
    answerSession()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(userData, { recursive: true, force: true })
  })

  it('asks Codex in a throwaway home and publishes an entry for that version', async () => {
    answerVersion('codex-cli 0.159.2')
    const entry = await deriveEntry()

    expect(entry?.codexVersion).toBe('codex-cli 0.159.2')
    expect(entry?.noDaemon).toBe(true)
    expect(readCodexHookFlagEntry('codex-cli 0.159.2')).toEqual(entry)
    expect(readFileSync(versionFile('codex-cli 0.159.2'), 'utf-8')).toContain('sha256:stop')
    const invocation = mocks.runCodexAppServerSession.mock.calls[0][0]
    expect(invocation.env.CODEX_HOME).toContain('orca-codex-hook-trust-')
    expect(invocation.args[0]).toBe('-c')
  })

  it('verifies the complete flag with Codex before publishing it', async () => {
    answerVersion('codex-cli 0.159.2')
    await deriveEntry()

    const [definitionRun, verifyRun] = mocks.runCodexAppServerSession.mock.calls
    expect(definitionRun[0].args[1]).not.toMatch(/state\s*=/)
    expect(verifyRun[0].args[1]).toBe(readCodexHookFlagEntry('codex-cli 0.159.2')?.flag)
  })

  it('publishes nothing when Codex does not trust the complete flag', async () => {
    answerVersion('codex-cli 0.159.2')
    answerSession((command, flag) => listingFor(command, flag, 'sha256:', { trusted: false }))

    expect(await deriveEntry()).toBeNull()
    expect(existsSync(versionFile('codex-cli 0.159.2'))).toBe(false)
  })

  it('publishes for a Codex that predates Interrupt, approving the events it lists', async () => {
    answerVersion('codex-cli 0.133.0')
    answerSession((command, flag) =>
      listingFor(command, flag, 'sha256:', { interrupt: 'unlisted' })
    )

    const entry = await deriveEntry()

    expect(entry?.flag).toContain('sha256:stop')
    expect(entry?.flag).not.toContain(':interrupt:0:0')
  })

  it('publishes nothing when Codex lists Interrupt but does not trust its approval', async () => {
    answerVersion('codex-cli 0.159.2')
    answerSession((command, flag) =>
      listingFor(command, flag, 'sha256:', { interrupt: 'untrusted' })
    )

    expect(await deriveEntry()).toBeNull()
  })

  it('publishes nothing when Codex lists the approved hook as switched off', async () => {
    answerVersion('codex-cli 0.159.2')
    answerSession((command, flag) => listingFor(command, flag, 'sha256:', { enabled: false }))

    expect(await deriveEntry()).toBeNull()
    expect(existsSync(versionFile('codex-cli 0.159.2'))).toBe(false)
  })

  it('reuses the published entry for the same version without a Codex session', async () => {
    answerVersion('codex-cli 0.159.2')
    await deriveEntry()

    const entry = await deriveEntry()

    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(2)
    expect(entry?.codexVersion).toBe('codex-cli 0.159.2')
  })

  it('re-derives an entry whose definition this build no longer writes', async () => {
    answerVersion('codex-cli 0.159.2')
    const stale = buildCodexHookSessionFlag(
      hookCommand().replace('codex-hook', 'old-hook'),
      Object.fromEntries(
        CODEX_EVENTS.map((eventName) => [
          CODEX_EVENT_LABEL[eventName],
          { key: `k:${CODEX_EVENT_LABEL[eventName]}:0:0`, trustedHash: 'sha256:old' }
        ])
      )
    )!
    await deriveEntry()
    writeFileSync(versionFile('codex-cli 0.159.2'), `${stale}\n`)
    mocks.runCodexAppServerSession.mockClear()

    const entry = await deriveEntry()

    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(2)
    expect(entry?.flag).not.toBe(stale)
    expect(entry?.flag).toContain('sha256:stop')
  })

  it('keeps one entry per version, so panes on either binary carry their own', async () => {
    answerVersion('codex-cli 0.159.2')
    await deriveEntry()
    answerVersion('codex-cli 0.160.0')
    answerSession((command, flag) => listingFor(command, flag, 'sha256:new-'))

    const entry = await deriveEntry()

    expect(entry?.flag).toContain('sha256:new-stop')
    expect(readCodexHookFlagEntry('codex-cli 0.159.2')?.flag).toContain('sha256:stop')
    expect(readCodexHookFlagEntry('codex-cli 0.160.0')?.flag).toContain('sha256:new-stop')
  })

  it('publishes nothing when Codex does not report every event', async () => {
    answerVersion('codex-cli 0.159.2')
    answerSession(() => ({ data: [] }))

    expect(await deriveEntry()).toBeNull()
    expect(existsSync(versionFile('codex-cli 0.159.2'))).toBe(false)
  })

  it('publishes nothing, and does not throw, when the Codex session fails', async () => {
    answerVersion('codex-cli 0.159.2')
    mocks.runCodexAppServerSession.mockRejectedValue(new Error('timed out'))

    expect(await deriveEntry()).toBeNull()
  })

  it('publishes nothing when hooks turn off while a derivation is in flight', async () => {
    answerVersion('codex-cli 0.159.2')
    let enabled = true

    const entry = await deriveEntry('/opt/codex/bin/codex', () => enabled)
    expect(entry).not.toBeNull()
    rmSync(versionFile('codex-cli 0.159.2'))
    mocks.runCodexAppServerSession.mockImplementation(async (invocation, body) => {
      // Why mid-derivation: the opt-out lands after Codex answered, before the write.
      enabled = false
      return body({ request: async () => listingFor(hookCommand(), invocation.args[1]) })
    })

    expect(await deriveEntry('/opt/codex/bin/codex', () => enabled)).toBeNull()
    expect(existsSync(versionFile('codex-cli 0.159.2'))).toBe(false)
  })

  it('never recreates the table to publish once Codex hooks removed it', async () => {
    answerVersion('codex-cli 0.159.2')
    rmSync(getCodexHookFlagTablePath(), { recursive: true })

    expect(await deriveEntry()).toBeNull()
    expect(existsSync(getCodexHookFlagTablePath())).toBe(false)
  })

  it.each([
    [
      'an app-server timeout',
      Object.assign(new Error('slow'), { name: 'CodexAppServerTimeoutError' }),
      true
    ],
    ['a failed spawn', Object.assign(new Error('EAGAIN'), { syscall: 'spawn codex' }), true],
    [
      'a codex without the app-server',
      Object.assign(new Error('no app-server'), { name: 'CodexAppServerUnsupportedError' }),
      false
    ],
    [
      'an app-server that exits early',
      new Error('codex app-server exited before completing the session'),
      false
    ]
  ])('marks %s as worth retrying soon: %s', async (_label, error, transient) => {
    answerVersion('codex-cli 0.159.2')
    mocks.runCodexAppServerSession.mockRejectedValue(error)

    const result = await deriveCodexHookFlagEntry('/opt/codex/bin/codex', () => true)

    expect(result).toMatchObject({ entry: null, transient })
  })

  it('asks no app-server of a Codex older than the minimum, and says to update it', async () => {
    answerVersion('codex-cli 0.132.0')

    const result = await deriveCodexHookFlagEntry('/opt/codex/bin/codex', () => true)

    expect(result).toMatchObject({
      entry: null,
      transient: false,
      failure: 'Codex 0.132.0 is older than 0.133; update Codex for Orca status'
    })
    expect(mocks.runCodexAppServerSession).not.toHaveBeenCalled()
  })

  it.each(['codex-cli 0.133.0', 'codex-cli 0.200.0-alpha.1', 'codex-cli dev-build'])(
    'derives for %s, the minimum, newer, or a version it cannot read',
    async (version) => {
      answerVersion(version)

      expect(await deriveEntry()).not.toBeNull()
    }
  )

  it('reports why a binary yields no entry, and its version', async () => {
    answerVersion(null)

    expect(await deriveCodexHookFlagEntry('/opt/codex/bin/codex', () => true)).toEqual({
      codexVersion: null,
      entry: null,
      failure: '/opt/codex/bin/codex did not report its version',
      transient: false
    })
  })

  describe('on Windows, under a profile path the quote-free flag cannot spell', () => {
    const hostPlatform = process.platform

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.stubEnv('HOME', join(userData, 'John Smith'))
      vi.stubEnv('USERPROFILE', join(userData, 'John Smith'))
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    })

    it("carries the script's 8.3 name, which the bare spelling accepts", async () => {
      mocks.resolveWindowsShortPath.mockResolvedValue(
        'C:\\Users\\JOHNSM~1\\.orca\\agent-hooks\\codex-hook.cmd'
      )
      const shortCommand = 'C:/Users/JOHNSM~1/.orca/agent-hooks/codex-hook.cmd'
      answerSession((_command, flag) => listingFor(shortCommand, flag))
      answerVersion('codex-cli 0.159.2')

      const entry = await deriveEntry()

      expect(entry?.flag).toContain(
        "command = 'C:/Users/JOHNSM~1/.orca/agent-hooks/codex-hook.cmd'"
      )
      expect(entry?.flag).not.toMatch(/["%]/)
    })

    it('carries no hook when the volume keeps no 8.3 names', async () => {
      mocks.resolveWindowsShortPath.mockResolvedValue(null)
      answerVersion('codex-cli 0.159.2')

      expect(await deriveEntry()).toBeNull()
      expect(mocks.runCodexAppServerSession).not.toHaveBeenCalled()
    })
  })
})
