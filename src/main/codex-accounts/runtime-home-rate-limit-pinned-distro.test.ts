import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { CodexAccountSelectionTarget } from '../../shared/codex-selection-lane'
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

async function serviceFor(wsl: Record<string, string>, accounts: ReturnType<typeof account>[]) {
  const store = createStore(
    createSettings({
      codexManagedAccounts: accounts,
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl }
    })
  )
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // Launch's own home lookup, for its resolved (named) target.
  class LaunchHomeProbe extends CodexRuntimeHomeService {
    launchHome(target: CodexAccountSelectionTarget): string | null {
      return this.getWslCodexHomePathForSelection(target)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements every Store member this service reads.
  return new LaunchHomeProbe(store as never)
}

describe('Codex quota poll home with a gated, pinned WSL distro (E9)', () => {
  let wslHome: string

  beforeEach(() => {
    setupRuntimeHomeTest()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
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

  it('reads the same home launch uses for a default-lane pick: the named lane, not __default__', async () => {
    const defaultHome = createManagedAuth(testState.userDataDir, 'acc-default', '{"a":"d"}\n')
    const service = await serviceFor({ __default__: 'acc-default' }, [
      account('acc-default', 'Ubuntu', defaultHome)
    ])

    const poll = service.prepareForRateLimitFetch({ runtime: 'wsl' }, 'Ubuntu')
    const launch = service.launchHome({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(poll).toEqual({ kind: 'ready', codexHomePath: launch })
    expect(launch).not.toBe(defaultHome)
  })

  it('reads the same managed home launch uses for the pinned distro’s own pick', async () => {
    const ubuntuHome = createManagedAuth(testState.userDataDir, 'acc-ubuntu', '{"a":"u"}\n')
    const service = await serviceFor({ Ubuntu: 'acc-ubuntu' }, [
      account('acc-ubuntu', 'Ubuntu', ubuntuHome)
    ])

    expect(service.prepareForRateLimitFetch({ runtime: 'wsl' }, 'Ubuntu')).toEqual({
      kind: 'ready',
      codexHomePath: ubuntuHome
    })
    expect(service.launchHome({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(ubuntuHome)
  })
})
