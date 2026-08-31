import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { snapshotCodexResumeHomes } from './codex-resume-home-snapshot'
import { prepareCodexSessionResume } from './codex-session-resume-preparation'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import { createSettings } from '../codex-accounts/runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../codex-accounts/runtime-home-service-test-harness'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const lstatFaults = vi.hoisted(() => {
  const state = {
    remaining: new Map<string, number>(),
    reads: new Map<string, number>(),
    failNext(path: string, count = 1): void {
      state.remaining.set(path, count)
    },
    reset(): void {
      state.remaining.clear()
      state.reads.clear()
    },
    readsFor(path: string): number {
      return state.reads.get(path) ?? 0
    },
    consume(target: unknown): void {
      if (typeof target !== 'string') {
        return
      }
      const left = state.remaining.get(target) ?? 0
      if (left <= 0) {
        return
      }
      state.remaining.set(target, left - 1)
      state.reads.set(target, (state.reads.get(target) ?? 0) + 1)
      const error: NodeJS.ErrnoException = new Error(
        `EBUSY: resource busy or locked, lstat '${target}'`
      )
      error.code = 'EBUSY'
      error.syscall = 'lstat'
      error.path = target
      throw error
    }
  }
  return state
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const original = actual.lstatSync as (...args: unknown[]) => unknown
  const patched: Record<string, unknown> = {
    ...actual,
    lstatSync: Object.assign((...args: unknown[]): unknown => {
      lstatFaults.consume(args[0])
      return original(...args)
    }, original)
  }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

function writeCompetingAlias(homePath: string): void {
  const datedDir = join(homePath, 'sessions', '2026', '07', '20')
  mkdirSync(datedDir, { recursive: true })
  writeFileSync(
    join(datedDir, `rollout-2026-07-20T15-50-19-${SESSION_ID}.jsonl`),
    '{"session":"alias"}\n',
    'utf-8'
  )
}

async function createTwoAccountService(): Promise<{
  service: {
    getHostCodexHomePathsForSessionDiscovery: () => string[]
    resolveSelectedHostAccountCodexHomePathForResume: () => string | null
  }
  store: ReturnType<typeof createStore>
  homeA: string
  homeB: string
}> {
  writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
  const homeA = createManagedAuth(
    testState.userDataDir,
    'account-a',
    createCodexAuthJson('a@example.com', 'acct-a', 'refresh-a')
  )
  const homeB = createManagedAuth(
    testState.userDataDir,
    'account-b',
    createCodexAuthJson('b@example.com', 'acct-b', 'refresh-b')
  )
  writeCompetingAlias(homeA)
  writeCompetingAlias(homeB)
  const store = createStore(
    createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        createCodexAccountRecord('account-a', 'a@example.com', 'acct-a', homeA),
        createCodexAccountRecord('account-b', 'b@example.com', 'acct-b', homeB)
      ],
      activeCodexManagedAccountId: 'account-a',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-a', wsl: {} }
    })
  )
  const { CodexRuntimeHomeService } = await import('../codex-accounts/runtime-home-service')
  return {
    service: new CodexRuntimeHomeService(store as never),
    store,
    homeA,
    homeB
  }
}

async function resumeFromSnapshot(snapshot: {
  trustedCodexHomes: readonly string[]
  selectedAccountCodexHome: string | null
}): Promise<{ outcome: string; codexHomePath?: string }> {
  return prepareCodexSessionResume({
    sessionId: SESSION_ID,
    transcriptPath: undefined,
    trustedCodexHomes: snapshot.trustedCodexHomes,
    getSelectedAccountCodexHome: () => snapshot.selectedAccountCodexHome,
    systemCodexHomePath: getSystemCodexHomePath(),
    sharedRuntimeCodexHomePath: getOrcaManagedCodexHomePath(),
    resolveVerifiedResumeHome: async (source) => source.homePath
  })
}

describe('STA-4919 Codex resume home snapshot', () => {
  beforeEach(() => {
    lstatFaults.reset()
    setupRuntimeHomeTest()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    lstatFaults.reset()
    teardownRuntimeHomeTest()
  })

  it('omits a home from discovery while its ownership marker is locked', async () => {
    const { service, homeA, homeB } = await createTwoAccountService()
    const markerA = join(realpathSync(homeA), '.orca-managed-home')
    lstatFaults.failNext(markerA, 1)

    const discovered = service.getHostCodexHomePathsForSessionDiscovery()
    expect(discovered).not.toContain(homeA)
    expect(discovered).toContain(homeB)
    expect(lstatFaults.readsFor(markerA)).toBe(1)
    // The lock has cleared; selection must still be able to verify A.
    expect(service.resolveSelectedHostAccountCodexHomePathForResume()).toBe(homeA)
  })

  it('resumes under the selected account, not a competing alias, after a transient discovery miss', async () => {
    const { service, homeA, homeB } = await createTwoAccountService()
    const markerA = join(realpathSync(homeA), '.orca-managed-home')
    lstatFaults.failNext(markerA, 1)

    const snapshot = snapshotCodexResumeHomes({
      systemHomePath: getSystemCodexHomePath(),
      runtimeHome: service
    })

    expect(lstatFaults.readsFor(markerA)).toBe(1)
    expect(snapshot.selectedAccountCodexHome).toBe(homeA)
    expect(snapshot.trustedCodexHomes).toContain(homeA)
    expect(snapshot.trustedCodexHomes).toContain(homeB)

    await expect(resumeFromSnapshot(snapshot)).resolves.toEqual({
      outcome: 'resume',
      codexHomePath: homeA
    })
  })

  it('propagates a still-indeterminate selected home instead of admitting or skipping it', async () => {
    const { service, homeA } = await createTwoAccountService()
    const markerA = join(realpathSync(homeA), '.orca-managed-home')
    lstatFaults.failNext(markerA, 2)
    const { ManagedCodexHomeTemporarilyUnavailableError } =
      await import('../codex-accounts/host-codex-managed-home-ownership')

    expect(() =>
      snapshotCodexResumeHomes({
        systemHomePath: getSystemCodexHomePath(),
        runtimeHome: service
      })
    ).toThrow(ManagedCodexHomeTemporarilyUnavailableError)
    expect(lstatFaults.readsFor(markerA)).toBe(2)
  })

  it('deduplicates equivalent Windows home spellings while preserving the first path', () => {
    const selectedHome = 'c:/users/test-user/.codex/'
    const discoveredHome = String.raw`C:\Users\Test-User\.codex`

    expect(
      snapshotCodexResumeHomes({
        systemHomePath: String.raw`C:\Users\System\.codex`,
        runtimeHome: {
          getHostCodexHomePathsForSessionDiscovery: () => [discoveredHome],
          resolveSelectedHostAccountCodexHomePathForResume: () => selectedHome
        }
      })
    ).toEqual({
      trustedCodexHomes: [String.raw`C:\Users\System\.codex`, discoveredHome],
      selectedAccountCodexHome: selectedHome
    })
  })

  it('still excludes a genuinely untrusted home that holds a competing alias', async () => {
    const { service, homeA, store } = await createTwoAccountService()
    const untrustedHome = join(testState.userDataDir, 'outside', 'account-c', 'home')
    mkdirSync(untrustedHome, { recursive: true })
    writeFileSync(join(untrustedHome, '.orca-managed-home'), 'account-c\n', 'utf-8')
    writeFileSync(
      join(untrustedHome, 'auth.json'),
      createCodexAuthJson('c@example.com', 'acct-c', 'refresh-c'),
      'utf-8'
    )
    writeCompetingAlias(untrustedHome)
    const settings = store.getSettings()
    settings.codexManagedAccounts = [
      ...settings.codexManagedAccounts,
      createCodexAccountRecord('account-c', 'c@example.com', 'acct-c', untrustedHome)
    ]

    const snapshot = snapshotCodexResumeHomes({
      systemHomePath: getSystemCodexHomePath(),
      runtimeHome: service
    })

    expect(snapshot.selectedAccountCodexHome).toBe(homeA)
    expect(snapshot.trustedCodexHomes).not.toContain(untrustedHome)
    await expect(resumeFromSnapshot(snapshot)).resolves.toEqual({
      outcome: 'resume',
      codexHomePath: homeA
    })
  })

  it('does not admit the selected path when that home is untrusted', async () => {
    const { service, homeA, store } = await createTwoAccountService()
    writeFileSync(join(homeA, '.orca-managed-home'), 'someone-else\n', 'utf-8')

    const snapshot = snapshotCodexResumeHomes({
      systemHomePath: getSystemCodexHomePath(),
      runtimeHome: service
    })

    expect(snapshot.selectedAccountCodexHome).toBeNull()
    expect(snapshot.trustedCodexHomes).not.toContain(homeA)
    expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
    const preparation = await resumeFromSnapshot(snapshot)
    expect(preparation).toMatchObject({ outcome: 'resume' })
    expect(preparation.codexHomePath).not.toBe(homeA)
    expect(preparation.codexHomePath).toBeDefined()
  })
})
