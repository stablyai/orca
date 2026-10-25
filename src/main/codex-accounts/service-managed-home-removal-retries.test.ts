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

  it('removes managed homes with bounded rm retries for transient Windows locks', async () => {
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

      expect(existsSync(managedHomePath)).toBe(false)
      const homeRemoval = rmSyncSpy.mock.calls.find(([target]) => target === managedHomePath)
      expect(homeRemoval?.[1]).toMatchObject({
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150
      })
    } finally {
      vi.doUnmock('node:fs')
    }
  })

  it('does not throw when managed home removal keeps failing on a held handle', async () => {
    vi.resetModules()
    const actualFs = await vi.importActual<typeof NodeFs>('node:fs')
    let managedHomePath = ''
    const lockedError = Object.assign(new Error('ENOTEMPTY: directory not empty'), {
      code: 'ENOTEMPTY'
    })
    const rmSyncSpy = vi.fn((target: Parameters<typeof actualFs.rmSync>[0], options) => {
      if (target === managedHomePath) {
        throw lockedError
      }
      actualFs.rmSync(target, options)
    })
    vi.doMock('node:fs', () => ({ ...actualFs, rmSync: rmSyncSpy }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      managedHomePath = actualFs.realpathSync(createManagedHome(testState.userDataDir, 'account-1'))
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      expect(() =>
        (
          service as unknown as {
            safeRemoveManagedHome(candidatePath: string, expectedAccountId: string): void
          }
        ).safeRemoveManagedHome(managedHomePath, 'account-1')
      ).not.toThrow()
      expect(warnSpy).toHaveBeenCalledWith(
        '[codex-accounts] Failed to remove managed home:',
        lockedError
      )
    } finally {
      warnSpy.mockRestore()
      vi.doUnmock('node:fs')
    }
  })
})
