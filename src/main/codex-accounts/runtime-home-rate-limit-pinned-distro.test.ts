import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('../wsl/wsl-background-exec-gate', () => ({ blockedWslDistroForExec: async () => null }))
vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock(import('node:os'), async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: () => testState.fakeHomeDir
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function account(id: string, distro: string, managedHomePath: string) {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath,
    managedHomeRuntime: 'wsl' as const,
    wslDistro: distro,
    wslLinuxHomePath: `/home/alice/.local/share/orca/codex-accounts/${id}/home`,
    providerAccountId: null,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

describe('Codex quota poll home with a gated, pinned WSL distro (E9)', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      // The cached `--list` default disagrees with the gated one; the pin must win for paths.
      getDefaultWslDistro: () => 'Debian',
      getWslHome: () => wslHome,
      getWslHomeAsync: async () => wslHome
    }))
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    teardownRuntimeHomeTest()
  })

  it('keeps the default-lane account when the gated default distro is pinned', async () => {
    const defaultHome = createManagedAuth(testState.userDataDir, 'acc-default', '{"a":"d"}\n')
    const debianHome = createManagedAuth(testState.userDataDir, 'acc-debian', '{"a":"b"}\n')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          account('acc-default', 'Ubuntu', defaultHome),
          account('acc-debian', 'Debian', debianHome)
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: {
          host: null,
          wsl: { __default__: 'acc-default', Debian: 'acc-debian' }
        }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements every Store member this service reads.
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForRateLimitFetch({ runtime: 'wsl' }, 'Ubuntu')).toEqual({
      kind: 'ready',
      codexHomePath: defaultHome
    })
  })
})
