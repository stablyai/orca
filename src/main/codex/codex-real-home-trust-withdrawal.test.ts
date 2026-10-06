import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import type * as EntryTrust from './codex-real-home-entry-trust'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand, type HookDefinition } from '../agent-hooks/installer-utils'
import type { CodexManagedTrustGrantPlan } from './codex-hook-trust-grant'
import { computeTrustedHash, upsertHookTrustEntries } from './config-toml-trust'

const { homedirMock, grantMock, beforeTrustRead } = vi.hoisted(() => {
  // Why: the withdrawal's only step between its hooks.json read and write.
  const beforeTrustRead: { run: (() => void) | null } = { run: null }
  return { homedirMock: vi.fn<() => string>(), grantMock: vi.fn(), beforeTrustRead }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})
vi.mock('./codex-real-home-entry-trust', async (importOriginal) => {
  const actual = await importOriginal<typeof EntryTrust>()
  return {
    readOrcaEntryTrust: (...args: Parameters<typeof actual.readOrcaEntryTrust>) => {
      const run = beforeTrustRead.run
      beforeTrustRead.run = null
      run?.()
      return actual.readOrcaEntryTrust(...args)
    }
  }
})
vi.mock('./codex-hook-trust-grant', () => ({
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS: 300_000,
  findCurrentManagedCodexHookTrust: async () => null,
  grantManagedCodexHookTrust: grantMock
}))

import {
  ensureRealHomeCodexHookState as startRealHomeCodexHookEnsure,
  _internals
} from './codex-real-home-hook-install'

/** The lane once Codex's background approval, if any, has settled. */
async function ensureRealHomeCodexHookState(
  args: Parameters<typeof startRealHomeCodexHookEnsure>[0]
): ReturnType<typeof startRealHomeCodexHookEnsure> {
  await startRealHomeCodexHookEnsure(args)
  return _internals.settledVerdictForTesting()
}
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'

// Why these tests: a failed trust session withdraws only what that call wrote and
// is still untrusted. Every Orca on this HOME shares the file, so anything else
// in it, including an identical entry another Orca trusted, must survive.

let homeDir: string
let userDataDir: string
const SAVED_MEANWHILE = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'saved-meanwhile.sh' }] }] } }, null, 2)}\n`

function hooksJsonPath(): string {
  return join(homeDir, '.codex', 'hooks.json')
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'orca-real-home-withdrawal-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-real-home-withdrawal-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataDir)
  homedirMock.mockReturnValue(homeDir)
  mkdirSync(join(homeDir, '.codex'), { recursive: true })
  _internals.resetForTesting('pending')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  beforeTrustRead.run = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  grantMock.mockReset()
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

it('keeps a hooks.json save that lands during a failed real-home grant', async () => {
  writeFileSync(hooksJsonPath(), `${JSON.stringify({ hooks: {} }, null, 2)}\n`)
  grantMock.mockImplementation(() => {
    writeFileSync(hooksJsonPath(), SAVED_MEANWHILE)
    return { lane: 'fallback', reason: 'error' }
  })

  expect(
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
  ).toBe('unavailable')

  expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(SAVED_MEANWHILE)
})

type HooksFile = { hooks: Record<string, HookDefinition[]> }

function readHooks(): HooksFile {
  return JSON.parse(readFileSync(hooksJsonPath(), 'utf-8'))
}

function writeHooks(file: HooksFile): string {
  const raw = `${JSON.stringify(file, null, 2)}\n`
  writeFileSync(hooksJsonPath(), raw)
  return raw
}

function orcaCommands(file: HooksFile): string[] {
  const { command } = getCodexManagedHookInstallMaterial()
  return Object.values(file.hooks)
    .flat()
    .flatMap((definition) => definition.hooks ?? [])
    .map((hook) => hook.command)
    .filter((candidate) => candidate === command)
}

const userHook = (command: string) => ({ hooks: [{ type: 'command' as const, command }] })

it('withdraws only what the failed call added; adds made during the session survive', async () => {
  writeHooks({ hooks: { Stop: [userHook('before.sh')] } })
  grantMock.mockImplementation(() => {
    const file = readHooks()
    file.hooks.Stop!.push(userHook('appended-during-session.sh'))
    file.hooks.PreCompact = [userHook('added-during-session.sh')]
    writeHooks(file)
    return { lane: 'fallback', reason: 'error' }
  })

  expect(
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
  ).toBe('unavailable')

  expect(readHooks()).toEqual({
    hooks: {
      Stop: [userHook('before.sh'), userHook('appended-during-session.sh')],
      PreCompact: [userHook('added-during-session.sh')]
    }
  })
})

it('keeps an entry another Orca trusted during the failed session', async () => {
  grantMock.mockImplementation((plan: CodexManagedTrustGrantPlan) => {
    const stop = plan.managedEntries.find((entry) => entry.eventLabel === 'stop')!
    upsertHookTrustEntries(join(homeDir, '.codex', 'config.toml'), [
      { ...stop, trustedHash: computeTrustedHash(stop) }
    ])
    return { lane: 'fallback', reason: 'error' }
  })

  expect(
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
  ).toBe('unavailable')

  const file = readHooks()
  expect(Object.keys(file.hooks)).toEqual(['Stop'])
  expect(orcaCommands(file)).toHaveLength(1)
})

it.skipIf(process.platform === 'win32')(
  "puts an older build's entry back in its slot when the one-time conversion cannot be trusted",
  async () => {
    const older = wrapPosixHookCommand(join(homeDir, '.orca', 'agent-hooks', 'codex-hook.sh'))
    const { events } = getCodexManagedHookInstallMaterial()
    const original = writeHooks({
      hooks: Object.fromEntries(
        events.map((event) => [
          event,
          [{ hooks: [{ type: 'command', command: older, timeout: 10 }] }, userHook('after.sh')]
        ])
      )
    })
    grantMock.mockReturnValue({ lane: 'fallback', reason: 'error' })

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'convert-older-forms'
      })
    ).toBe('unavailable')

    expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(original)
  }
)

it.skipIf(process.platform === 'win32')(
  'withdraws the copy the failed conversion wrote, not an earlier frozen copy in a matcher group',
  async () => {
    const older = wrapPosixHookCommand(join(homeDir, '.orca', 'agent-hooks', 'codex-hook.sh'))
    const { command, events } = getCodexManagedHookInstallMaterial()
    const matched = { matcher: 'Bash', hooks: [{ type: 'command' as const, command }] }
    const original = writeHooks({
      hooks: Object.fromEntries(
        events.map((event) => [
          event,
          [matched, userHook('between.sh'), { hooks: [{ type: 'command', command: older }] }]
        ])
      )
    })
    grantMock.mockReturnValue({ lane: 'fallback', reason: 'error' })

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'convert-older-forms'
      })
    ).toBe('unavailable')

    expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(original)
  }
)

it('keeps a hooks.json save that lands between the withdrawal read and its write', async () => {
  writeHooks({ hooks: {} })
  grantMock.mockReturnValue({ lane: 'fallback', reason: 'error' })
  beforeTrustRead.run = () => {
    writeFileSync(hooksJsonPath(), SAVED_MEANWHILE)
  }

  expect(
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
  ).toBe('unavailable')

  expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(SAVED_MEANWHILE)
})
