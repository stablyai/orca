import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const bridge = vi.hoisted(() => ({
  start: vi.fn<(target: Record<string, string>) => Promise<void>>(() => Promise.resolve())
}))

vi.mock('../codex/wsl-codex-session-bridge', () => ({
  startWslCodexSessionBridgeInBackground: bridge.start
}))

let wslHome = ''
vi.mock('../wsl', () => ({
  getDefaultWslDistro: () => 'Ubuntu',
  getWslHome: () => wslHome
}))

function accountsRoot(): string {
  return join(wslHome, '.local', 'share', 'orca', 'codex-accounts')
}

function wslAccount(id: string, distro: string) {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: join(accountsRoot(), id, 'home'),
    managedHomeRuntime: 'wsl' as const,
    wslDistro: distro,
    wslLinuxHomePath: join(accountsRoot(), id, 'home'),
    providerAccountId: null,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

async function createService(selectedUbuntuAccount: string | null) {
  const store = createStore(
    createSettings({
      codexManagedAccounts: [
        wslAccount('a', 'Ubuntu'),
        wslAccount('b', 'Ubuntu'),
        wslAccount('other-distro', 'Debian')
      ],
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: selectedUbuntuAccount }
      }
    })
  )
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the getSettings/updateSettings surface this service reads.
  return new CodexRuntimeHomeService(store as never)
}

describe('WSL sibling account session bridging', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    setupRuntimeHomeTest()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslHome = join(testState.userDataDir, 'ubuntu-home')
    bridge.start.mockReset()
    bridge.start.mockImplementation(() => Promise.resolve())
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    teardownRuntimeHomeTest()
  })

  it('lets a concurrent launch join the sibling loop already bridging that home', async () => {
    let releaseFirst: () => void = () => {}
    bridge.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    )
    const service = await createService('b')

    service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(1))
    releaseFirst()
    await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(bridge.start).toHaveBeenCalledTimes(2)
  })
})
