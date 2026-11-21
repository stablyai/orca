import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { CodexAccountService as CodexAccountServiceInstance } from '../service'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'
import { createCodexAccountRecord } from '../runtime-home/runtime-home-service-test-harness'

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

describe('Codex account selection broadcast', () => {
  registerCodexAccountsTestHomes()

  // #43107: a switch from the CLI or a paired phone must reach every window's status bar.
  it.each([
    {
      change: 'select',
      apply: (service: CodexAccountServiceInstance) => service.selectAccount('b'),
      expected: {
        activeCodexManagedAccountId: 'b',
        activeCodexManagedAccountIdsByRuntime: { host: 'b', wsl: {} }
      }
    },
    {
      change: 'remove',
      apply: (service: CodexAccountServiceInstance) => service.removeAccount('a'),
      expected: {
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
      }
    }
  ])(
    'tells settings listeners about a $change made outside the window',
    async ({ apply, expected }) => {
      const store = createStore(
        createSettings({
          codexManagedAccounts: [
            createCodexAccountRecord(
              'a',
              'a@example.com',
              'acct-a',
              createManagedHome(testState.userDataDir, 'a')
            ),
            createCodexAccountRecord(
              'b',
              'b@example.com',
              'acct-b',
              createManagedHome(testState.userDataDir, 'b')
            )
          ],
          activeCodexManagedAccountId: 'a',
          activeCodexManagedAccountIdsByRuntime: { host: 'a', wsl: {} }
        })
      )
      const broadcasts: Partial<GlobalSettings>[] = []
      store.onSettingsChanged((updates) => broadcasts.push(updates))
      const { CodexAccountService } = await import('../service')
      const service = new CodexAccountService(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: select/remove read only getSettings/updateSettings, which the harness store implements.
        store as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness stub implements the rate-limit members the service calls on a switch.
        createRateLimits() as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness stub implements the runtime-home members the service calls on a switch.
        createRuntimeHome() as never
      )

      await apply(service)

      expect(broadcasts).toContainEqual(expect.objectContaining(expected))
    }
  )
})
