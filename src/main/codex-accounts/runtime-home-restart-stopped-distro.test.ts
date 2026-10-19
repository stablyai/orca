import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { CodexAccountSelectionTarget } from './runtime-selection'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

const { isWslDistroRunningMock } = vi.hoisted(() => ({
  isWslDistroRunningMock: vi.fn<(distro: string) => Promise<boolean>>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
vi.mock('../wsl-background-distro-gate', () => ({
  isWslDistroRunning: isWslDistroRunningMock
}))

function wslAccount(id: string, distro: string): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: `\\\\wsl.localhost\\${distro}\\home\\user\\.codex-${id}`,
    managedHomeRuntime: 'wsl',
    wslDistro: distro,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

describe('Codex WSL auth preservation before restart', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    setupRuntimeHomeTest()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    isWslDistroRunningMock.mockImplementation(async (distro) => distro === 'Ubuntu')
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    teardownRuntimeHomeTest()
  })

  it('drains only running distros so a restart never boots a stopped one', async () => {
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const drained: (string | null | undefined)[] = []
    class DrainRecorder extends CodexRuntimeHomeService {
      protected override startLegacyWslAuthDrain(
        target: CodexAccountSelectionTarget
      ): Promise<void> {
        drained.push(target.wslDistro)
        return Promise.resolve()
      }
    }
    const store = createStore(
      createSettings({
        codexManagedAccounts: [wslAccount('a', 'Ubuntu'), wslAccount('b', 'Debian')],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'a', Debian: 'b' } }
      })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the subset the service reads.
    const service = new DrainRecorder(store as never)

    await service.syncActiveWslSelectionsBeforeRestart()

    expect(drained).toEqual(['Ubuntu'])
    expect(isWslDistroRunningMock).toHaveBeenCalledWith('Debian')
  })
})
