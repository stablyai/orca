import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { realpathSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as CodexConfigMirror from '../codex/codex-config-mirror'
import type * as CodexHomePaths from '../codex/codex-home-paths'
import type * as CodexSessionBackfillMarker from '../codex/codex-session-backfill-marker'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexHomePath,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

const lstatFaults = vi.hoisted(() => {
  const state = {
    held: new Set<string>(),
    reads: new Map<string, number>(),
    hold(path: string): void {
      state.held.add(path)
    },
    release(path: string): void {
      state.held.delete(path)
    },
    heldReads(path: string): number {
      return state.reads.get(path) ?? 0
    },
    reset(): void {
      state.held.clear()
      state.reads.clear()
    },
    consume(target: unknown): void {
      if (typeof target !== 'string' || !state.held.has(target)) {
        return
      }
      state.reads.set(target, (state.reads.get(target) ?? 0) + 1)
      const error: NodeJS.ErrnoException = new Error(
        `EPERM: operation not permitted, lstat '${target}'`
      )
      error.code = 'EPERM'
      error.errno = -4048
      error.syscall = 'lstat'
      error.path = target
      throw error
    }
  }
  return state
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widens lstatSync's overloads so the passthrough wrapper forwards any call shape.
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
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

async function importServiceWithSideEffectSpies() {
  const syncResources = vi.fn()
  const syncConfig = vi.fn()
  const systemBridge = vi.fn(async () => {})
  const accountBridge = vi.fn(async () => {})
  const backfillMarker = vi.fn(() => false)
  vi.doMock('../codex/codex-home-paths', async () => ({
    ...(await vi.importActual<typeof CodexHomePaths>('../codex/codex-home-paths')),
    syncSystemCodexResourcesIntoManagedHome: syncResources
  }))
  vi.doMock('../codex/codex-config-mirror', async () => ({
    ...(await vi.importActual<typeof CodexConfigMirror>('../codex/codex-config-mirror')),
    syncSystemConfigIntoManagedCodexHome: syncConfig
  }))
  vi.doMock('../codex/codex-session-bridge', () => ({
    startSystemCodexSessionBridgeInBackground: systemBridge
  }))
  vi.doMock('../codex/codex-account-session-bridge', () => ({
    startCodexAccountSessionBridgeInBackground: accountBridge
  }))
  vi.doMock('../codex/codex-session-backfill-marker', async () => ({
    ...(await vi.importActual<typeof CodexSessionBackfillMarker>(
      '../codex/codex-session-backfill-marker'
    )),
    markCodexSessionBackfillMarkerPending: backfillMarker
  }))
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  return {
    CodexRuntimeHomeService,
    sideEffects: { syncResources, syncConfig, systemBridge, accountBridge, backfillMarker }
  }
}

function expectNoSideEffects(
  sideEffects: Record<string, ReturnType<typeof vi.fn>>,
  store: { updateSettings: ReturnType<typeof vi.fn> }
): void {
  for (const [name, spy] of Object.entries(sideEffects)) {
    expect(spy, name).not.toHaveBeenCalled()
  }
  expect(store.updateSettings).not.toHaveBeenCalled()
}

// Exclude constructor synchronization from the resolver's assertion window.
function clearSideEffectCalls(
  sideEffects: Record<string, ReturnType<typeof vi.fn>>,
  store: { updateSettings: ReturnType<typeof vi.fn> }
): void {
  for (const spy of Object.values(sideEffects)) {
    spy.mockClear()
  }
  store.updateSettings.mockClear()
}

async function createServiceWithSpies(settings: ReturnType<typeof createSettings>) {
  const store = createStore(settings)
  const { CodexRuntimeHomeService, sideEffects } = await importServiceWithSideEffectSpies()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the settings read/update surface the service uses.
  const service = new CodexRuntimeHomeService(store as never)
  clearSideEffectCalls(sideEffects, store)
  return { service, store, sideEffects }
}

function managedAccountSettings(managedHomePath: string) {
  return createSettings({
    realHomeRoutable: true,
    codexManagedAccounts: [
      createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', managedHomePath)
    ],
    activeCodexManagedAccountId: 'account-1',
    activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
  })
}

describe('resolveHostCodexHomePathForLaunchReadOnly', () => {
  beforeEach(() => {
    lstatFaults.reset()
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    lstatFaults.reset()
    teardownRuntimeHomeTest()
  })

  it('managed account: answers the account home with zero side effects, then matches launch prep', async () => {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    const { service, store, sideEffects } = await createServiceWithSpies(
      managedAccountSettings(managedHomePath)
    )

    const readOnlyHome = service.resolveHostCodexHomePathForLaunchReadOnly()
    expect(readOnlyHome).toBe(managedHomePath)
    expectNoSideEffects(sideEffects, store)

    // Prove the spies detect actual launch side effects.
    expect(service.prepareForCodexLaunch()).toBe(readOnlyHome)
    expect(sideEffects.syncResources).toHaveBeenCalled()
    expect(sideEffects.accountBridge).toHaveBeenCalled()
  })

  it('system-default real home: answers null (real ~/.codex) with zero side effects, matching launch prep', async () => {
    const { service, store, sideEffects } = await createServiceWithSpies(
      createSettings({ realHomeRoutable: true })
    )

    const readOnlyHome = service.resolveHostCodexHomePathForLaunchReadOnly()
    expect(readOnlyHome).toBeNull()
    expectNoSideEffects(sideEffects, store)

    expect(service.prepareForCodexLaunch()).toBe(readOnlyHome)
  })

  it('shared runtime home: answers the mirror with zero side effects, then matches launch prep', async () => {
    const { service, store, sideEffects } = await createServiceWithSpies(
      createSettings({ realHomeRoutable: false })
    )

    const readOnlyHome = service.resolveHostCodexHomePathForLaunchReadOnly()
    expect(readOnlyHome).toBe(getRuntimeCodexHomePath())
    expectNoSideEffects(sideEffects, store)

    expect(service.prepareForCodexLaunch()).toBe(readOnlyHome)
    expect(sideEffects.syncResources).toHaveBeenCalled()
    expect(sideEffects.systemBridge).toHaveBeenCalled()
  })

  it('untrusted managed home: predicts the launch-prep fall-through route but keeps the selection set', async () => {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    const { service, store, sideEffects } = await createServiceWithSpies(
      managedAccountSettings(managedHomePath)
    )
    // Change ownership after construction so its initial sync cannot clear the selection.
    writeFileSync(join(managedHomePath, '.orca-managed-home'), 'someone-else\n', 'utf-8')

    const readOnlyHome = service.resolveHostCodexHomePathForLaunchReadOnly()
    expect(readOnlyHome).toBeNull()
    expectNoSideEffects(sideEffects, store)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')

    expect(service.prepareForCodexLaunch()).toBe(readOnlyHome)
    expect(store.updateSettings).toHaveBeenCalled()
    expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
  })

  it('temporarily unreadable managed home: both paths refuse and the selection is untouched', async () => {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    const { service, store, sideEffects } = await createServiceWithSpies(
      managedAccountSettings(managedHomePath)
    )
    const { ManagedCodexHomeTemporarilyUnavailableError } =
      await import('./host-codex-managed-home-ownership')
    expect(service.resolveHostCodexHomePathForLaunchReadOnly()).toBe(managedHomePath)
    const markerPath = join(realpathSync(managedHomePath), '.orca-managed-home')
    lstatFaults.hold(markerPath)

    expect(() => service.resolveHostCodexHomePathForLaunchReadOnly()).toThrow(
      ManagedCodexHomeTemporarilyUnavailableError
    )
    expect(lstatFaults.heldReads(markerPath)).toBeGreaterThan(0)
    expectNoSideEffects(sideEffects, store)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')

    expect(() => service.prepareForCodexLaunch()).toThrow(
      ManagedCodexHomeTemporarilyUnavailableError
    )
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')

    lstatFaults.release(markerPath)
    expect(service.resolveHostCodexHomePathForLaunchReadOnly()).toBe(managedHomePath)
  })

  it('shares the create-path null-to-system-home mapping', async () => {
    const { service } = await createServiceWithSpies(createSettings({ realHomeRoutable: true }))
    const { resolveStructuredCodexAccountHomePath } =
      await import('../runtime/structured-agent-account-home')
    await expect(
      resolveStructuredCodexAccountHomePath({
        launchEnv: {},
        resolveLaunchHome: (input) =>
          service.resolveHostCodexHomePathForLaunchReadOnly(input.launchEnv)
      })
    ).resolves.toBe(getSystemCodexHomePath())
  })
})
