import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as WslDistroCatalog from '../../../wsl/discovery/distro-catalog'
import type * as LegacyWslRuntimeAuthDrain from '../../legacy-wsl-auth-drain/legacy-wsl-runtime-auth-drain'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { createSettings } from '../runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../runtime-home-service-test-harness'

const preparation = vi.hoisted(
  (): {
    history: () => void
    gate: () => { distro: string; state: 'stopped' } | null
  } => ({ history: () => {}, gate: () => null })
)
vi.mock('../../../wsl/discovery/wsl-background-exec-gate', () => ({
  blockedWslDistroForExec: async () => preparation.gate()
}))
vi.mock('../../../wsl/discovery/distro-catalog', async (original) => ({
  ...(await original<typeof WslDistroCatalog>()),
  getDefaultWslDistro: () => 'Ubuntu',
  getWslHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\dev',
  getWslHomeAsync: async () => '\\\\wsl.localhost\\Ubuntu\\home\\dev'
}))
vi.mock('../../legacy-wsl-auth-drain/legacy-wsl-runtime-auth-drain', async (original) => ({
  ...(await original<typeof LegacyWslRuntimeAuthDrain>()),
  startLegacyWslRuntimeAuthDrain: async () => {}
}))
vi.mock('../../../codex/history/shared-store/wsl-codex-account-history', () => ({
  WslCodexAccountHistoryLaunches: class {
    async run(): Promise<void> {
      preparation.history()
    }
  }
}))
vi.mock(import('node:os'), async (original) => ({
  ...(await original()),
  homedir: () => testState.fakeHomeDir
}))

beforeEach(() => {
  setupRuntimeHomeTest()
  installFakeAppEnvironment({ getPath: () => testState.userDataDir })
})
afterEach(() => {
  preparation.history = () => {}
  preparation.gate = () => null
  teardownRuntimeHomeTest()
})

it.runIf(process.platform === 'win32').each(['history', 'gate'])(
  'refuses a system-default binding that appeared during WSL %s preparation',
  async (phase) => {
    const home = createManagedAuth(
      testState.userDataDir,
      'work-wsl',
      createCodexAuthJson('work@example.com', 'work', 'work')
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'work-wsl',
          email: 'work@example.com',
          managedHomePath: home,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: '/home/dev/orca-work',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'work-wsl' } }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this store fixture implements the runtime-home methods used by launch preparation.
    const service = new CodexRuntimeHomeService(store as never)
    const change = () =>
      store.updateSettings({ codexWorkspaceAccounts: { 'folder:client': 'system-default' } })
    if (phase === 'history') {
      preparation.history = change
    } else {
      preparation.gate = () => {
        change()
        return { distro: 'Ubuntu', state: 'stopped' }
      }
    }
    await expect(
      service.prepareForCodexLaunchAsync({ runtime: 'wsl', wslDistro: 'Ubuntu' }, undefined, {
        workspaceId: 'folder:client'
      })
    ).rejects.toThrow('changed during preparation')
  }
)
