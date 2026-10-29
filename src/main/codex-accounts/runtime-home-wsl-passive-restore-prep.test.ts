import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type * as CodexConfigMirror from '../codex/codex-config-mirror'
import type * as CodexHomePaths from '../codex/codex-home-paths'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

// The real rule: a stopped distro blocks, except for a user act on it.
vi.mock('../wsl/wsl-background-exec-gate', async () => {
  const { isWslUserActFor, runAsWslUserAct } = await import('../wsl/wsl-user-act-scope')
  return {
    blockedWslDistroForExec: async (distro: string | null | undefined) =>
      distro && !isWslUserActFor(distro) ? { distro, state: 'stopped' } : null,
    // The same scope instance the gate reads, whatever the module registry did between tests.
    runAsWslExecUserAct: runAsWslUserAct
  }
})
vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock(import('node:os'), async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: () => testState.fakeHomeDir
}))

const LINUX_ACCOUNT_HOME = '/home/alice/.local/share/orca/codex-accounts/account-1/home'

function wslMocks() {
  const mocks = {
    getWslHome: vi.fn(() => join(testState.userDataDir, 'wsl-home')),
    getWslHomeAsync: vi.fn(async () => join(testState.userDataDir, 'wsl-home')),
    drain: vi.fn(async () => {}),
    bridge: vi.fn(async () => {}),
    syncInstructions: vi.fn(),
    syncConfig: vi.fn()
  }
  vi.doMock('../wsl', () => ({
    getDefaultWslDistro: () => 'Ubuntu',
    getWslHome: mocks.getWslHome,
    getWslHomeAsync: mocks.getWslHomeAsync
  }))
  vi.doMock('./legacy-wsl-runtime-auth-drain', () => ({
    startLegacyWslRuntimeAuthDrain: mocks.drain
  }))
  vi.doMock('../codex/wsl-codex-session-bridge', () => ({
    startWslCodexSessionBridgeInBackground: mocks.bridge
  }))
  vi.doMock('../codex/codex-home-paths', async (importOriginal) => ({
    ...(await importOriginal<typeof CodexHomePaths>()),
    syncCodexGlobalInstructionsIntoManagedHome: mocks.syncInstructions
  }))
  vi.doMock('../codex/codex-config-mirror', async (importOriginal) => ({
    ...(await importOriginal<typeof CodexConfigMirror>()),
    syncSystemConfigIntoManagedCodexHome: mocks.syncConfig
  }))
  return mocks
}

function accountStore(selected: boolean) {
  const managedHomePath = createManagedAuth(
    testState.userDataDir,
    'account-1',
    createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed-token')
  )
  return createStore(
    createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'wsl@example.com',
          managedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: LINUX_ACCOUNT_HOME,
          providerAccountId: 'acct-wsl',
          workspaceLabel: null,
          workspaceAccountId: 'acct-wsl',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: selected ? 'account-1' : null }
      }
    })
  )
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  setupRuntimeHomeTest()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  teardownRuntimeHomeTest()
})

// A passive restore reaches launch prep before its hold (#35813); prep must not start the distro (E9).
describe('Codex launch prep for a stopped WSL distro', () => {
  it('a passive restore gets the account home without a probe, drain, sync or bridge', async () => {
    const mocks = wslMocks()
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the Store methods the runtime home service reads.
    const service = new CodexRuntimeHomeService(accountStore(true) as never)

    const home = await service.prepareForCodexLaunchAsync({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(home).toBeTruthy()
    expect(mocks.getWslHome).not.toHaveBeenCalled()
    expect(mocks.getWslHomeAsync).not.toHaveBeenCalled()
    expect(mocks.drain).not.toHaveBeenCalled()
    expect(mocks.syncInstructions).not.toHaveBeenCalled()
    expect(mocks.syncConfig).not.toHaveBeenCalled()
    expect(mocks.bridge).not.toHaveBeenCalled()
  })

  it('a passive restore on system default reads an unknown home as null, never probing', async () => {
    const mocks = wslMocks()
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the Store methods the runtime home service reads.
    const service = new CodexRuntimeHomeService(accountStore(false) as never)

    await expect(
      service.prepareForCodexLaunchAsync({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toBeNull()
    expect(mocks.getWslHome).not.toHaveBeenCalled()
  })

  it('the same launch as a user act warms the home off the main thread and drains', async () => {
    const mocks = wslMocks()
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const { runAsWslExecUserAct } = await import('../wsl/wsl-background-exec-gate')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the Store methods the runtime home service reads.
    const service = new CodexRuntimeHomeService(accountStore(true) as never)

    await runAsWslExecUserAct('Ubuntu', () =>
      service.prepareForCodexLaunchAsync({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    )

    expect(mocks.getWslHomeAsync).toHaveBeenCalledWith('Ubuntu')
    expect(mocks.drain).toHaveBeenCalledOnce()
  })
})
