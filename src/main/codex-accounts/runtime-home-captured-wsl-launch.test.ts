import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import type { WslAccountExecutionContext } from '../wsl/wsl-account-execution-context'
import type { CodexAccountSelectionTarget } from './runtime-selection'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('../wsl', () => ({
  getDefaultWslDistro: () => 'Other',
  getWslHome: () => '/home/default-changed'
}))

beforeEach(setupRuntimeHomeTest)
afterEach(teardownRuntimeHomeTest)

const owner = { distro: 'Ubuntu', userName: 'alice', userId: '1000', home: '/home/alice' }

describe('captured Codex launch preparation', () => {
  it.each([
    { distro: 'Debian', home: '/home/alice/account' },
    { distro: 'Ubuntu', home: '/home/bob/account' }
  ])(
    'refuses a selected managed account outside the captured owner: $distro $home',
    async ({ distro, home }) => {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      class CapturedService extends CodexRuntimeHomeService {
        resolveAccount(account: CodexManagedAccount): string | null {
          return this.getWslLaunchCodexHomePath(account, 'Ubuntu', owner)
        }
      }
      const store = createStore(createSettings({}))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the settings-store operations used during service construction.
      const service = new CapturedService(store as never)
      const account: CodexManagedAccount = {
        id: 'selected',
        email: 'test@example.com',
        managedHomePath: toWindowsWslUncPath(home, distro),
        managedHomeRuntime: 'wsl',
        wslDistro: distro,
        wslLinuxHomePath: home,
        providerAccountId: null,
        workspaceLabel: null,
        workspaceAccountId: null,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
      expect(() => service.resolveAccount(account)).toThrow('captured WSL')
    }
  )

  it('pins the selected home and finishing context while the drain awaits', async () => {
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const execution = { ...owner }
    const finish = vi.fn()
    class CapturedService extends CodexRuntimeHomeService {
      protected override async startLegacyWslAuthDrain(): Promise<void> {
        execution.userName = 'bob'
        execution.home = '/home/bob'
        await Promise.resolve()
      }
      protected override finishWslLaunchPreparation(
        target: CodexAccountSelectionTarget,
        home: string | null,
        captured?: WslAccountExecutionContext
      ): void {
        finish(target, home, captured)
      }
    }
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every settings-store operation used by launch preparation.
    const service = new CapturedService(store as never)
    const home = await service.prepareForCodexLaunchAsync(
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      undefined,
      { wslExecution: execution }
    )
    expect(home).toBe(toWindowsWslUncPath('/home/alice/.codex', 'Ubuntu'))
    expect(finish).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' }, home, owner)
    expect(Object.isFrozen(finish.mock.calls[0]?.[2])).toBe(true)
  })

  it('refuses a mismatched target before drain or finishing', async () => {
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const work = vi.fn()
    class CapturedService extends CodexRuntimeHomeService {
      protected override async startLegacyWslAuthDrain(): Promise<void> {
        work()
      }
      protected override finishWslLaunchPreparation(): void {
        work()
      }
    }
    const store = createStore(createSettings({}))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the settings-store operations used during service construction.
    const service = new CapturedService(store as never)
    await expect(
      service.prepareForCodexLaunchAsync({ runtime: 'wsl', wslDistro: 'Debian' }, undefined, {
        wslExecution: owner
      })
    ).rejects.toThrow('captured execution owner')
    expect(work).not.toHaveBeenCalled()
  })
})
