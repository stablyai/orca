import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { realpathSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
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
} from './runtime-home-service-test-harness'

const lstatFaults = vi.hoisted(() => {
  const state = {
    pending: new Map<string, number>(),
    held: new Set<string>(),
    failOnce(path: string): void {
      state.pending.set(path, (state.pending.get(path) ?? 0) + 1)
    },
    hold(path: string): void {
      state.held.add(path)
    },
    release(path: string): void {
      state.held.delete(path)
    },
    consumedHeld: new Map<string, number>(),
    heldReads(path: string): number {
      return state.consumedHeld.get(path) ?? 0
    },
    remaining(path: string): number {
      return state.pending.get(path) ?? 0
    },
    reset(): void {
      state.pending.clear()
      state.held.clear()
      state.consumedHeld.clear()
    },
    consume(target: unknown): void {
      if (typeof target !== 'string') {
        return
      }
      const remaining = state.pending.get(target) ?? 0
      const isHeld = state.held.has(target)
      if (remaining <= 0 && !isHeld) {
        return
      }
      if (isHeld) {
        state.consumedHeld.set(target, (state.consumedHeld.get(target) ?? 0) + 1)
      } else {
        state.pending.set(target, remaining - 1)
      }
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

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('STA-4422 Codex sessions keep logging out', () => {
  beforeEach(() => {
    lstatFaults.reset()
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    lstatFaults.reset()
    teardownRuntimeHomeTest()
  })

  it('keeps the selection and SKIPS the poll while the ownership marker is locked', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    const store = createStore(
      createSettings({
        realHomeRoutable: true,
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', managedHomePath)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: managedHomePath
    })
    expect(store.updateSettings).not.toHaveBeenCalled()

    // Hold the lock across retries so a one-shot fault cannot hide an unsafe fallback.
    const markerPath = join(realpathSync(managedHomePath), '.orca-managed-home')
    lstatFaults.hold(markerPath)

    const duringLock = service.prepareForRateLimitFetch()

    expect(lstatFaults.heldReads(markerPath)).toBeGreaterThan(0)
    expect(duringLock).toEqual({ kind: 'skip' })
    expect(
      service.resolveCodexManagedAccountHomeForInactiveFetch(
        store.getSettings().codexManagedAccounts[0]!
      )
    ).toEqual({ kind: 'skip' })
    expect(duringLock).not.toEqual({ kind: 'ready', codexHomePath: getSystemCodexHomePath() })
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime?.host).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()

    expect(service.prepareForRateLimitFetch()).toEqual({ kind: 'skip' })
    expect(service.prepareForRateLimitFetch()).toEqual({ kind: 'skip' })
    expect(store.updateSettings).not.toHaveBeenCalled()

    lstatFaults.release(markerPath)
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: managedHomePath
    })
    expect(
      service.resolveCodexManagedAccountHomeForInactiveFetch(
        store.getSettings().codexManagedAccounts[0]!
      )
    ).toEqual({ kind: 'ready', homePath: managedHomePath })
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('still clears the selection when the home is genuinely untrusted', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    writeFileSync(join(managedHomePath, '.orca-managed-home'), 'someone-else\n', 'utf-8')
    const store = createStore(
      createSettings({
        realHomeRoutable: true,
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', managedHomePath)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
    expect(store.updateSettings).toHaveBeenCalledTimes(1)
    expect(
      service.resolveCodexManagedAccountHomeForInactiveFetch(
        store.getSettings().codexManagedAccounts[0]!
      )
    ).toEqual({ kind: 'skip' })
  })
})
