import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { existsSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

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

describe('CodexAccountService config sync', () => {
  registerCodexAccountsTestHomes()

  it('retains legacy stores without recursively removing their trees', async () => {
    vi.resetModules()
    const actualFs = await vi.importActual<typeof NodeFs>('node:fs')
    const rmSyncSpy = vi.fn(actualFs.rmSync)
    vi.doMock('node:fs', () => ({ ...actualFs, rmSync: rmSyncSpy }))

    try {
      // Match ownership canonicalization, including /private/var paths on macOS.
      const managedHomePath = actualFs.realpathSync(
        createManagedHome(testState.userDataDir, 'account-1')
      )
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      ;(
        service as unknown as {
          safeRemoveManagedHome(candidatePath: string, expectedAccountId: string): void
        }
      ).safeRemoveManagedHome(managedHomePath, 'account-1')

      expect(existsSync(managedHomePath)).toBe(true)
      expect(rmSyncSpy.mock.calls.some(([target]) => target === managedHomePath)).toBe(false)
    } finally {
      vi.doUnmock('node:fs')
    }
  })
})
