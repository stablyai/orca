import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshConnectionStore } from '../../ssh/connection/ssh-connection-store'
import { createMockStore } from '../../ssh/connection/ssh-connection-store-test-fixture'
import { emptyDependentStateStore } from '../../ssh/targets/ssh-target-orcad-dependents-fixture'

const { registry, environments } = vi.hoisted(() => {
  const registry: { store: unknown } = { store: null }
  return { registry, environments: new Map<string, unknown>() }
})

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))
vi.mock('../../browser/browser-manager', () => ({ browserManager: {} }))
vi.mock('../../runtime/rpc/dispatcher', () => ({ RpcDispatcher: vi.fn() }))
vi.mock('../../runtime/rpc/methods/index', () => ({ ALL_RPC_METHODS: [] }))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: vi.fn()
}))
vi.mock('../runtime-environments/runtime-environment-status-probe', () => ({
  getRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('../ssh/ssh-ipc-context', () => ({ persistedStore: { getSettings: () => ({}) } }))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => registry.store
}))
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: (_userDataPath: string, id: string) => {
    const environment = environments.get(id)
    if (!environment) {
      throw new Error(`unknown environment ${id}`)
    }
    return environment
  }
}))

import { listDesktopBrowserBridgeCandidates } from './desktop-browser-bridge-wiring'

const base = { host: 'vm.example.com', port: 22, username: 'dev' }

function servedEnvironment(environmentId: string, sshTargetId: string, generation: number) {
  environments.set(environmentId, {
    id: environmentId,
    orcadDeployment: { sshTargetId, sshTargetGeneration: generation }
  })
}

describe('desktop browser bridge candidates', () => {
  let sshStore: SshConnectionStore

  beforeEach(() => {
    environments.clear()
    const store = Object.assign(createMockStore(), emptyDependentStateStore())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the store methods SshConnectionStore calls.
    sshStore = new SshConnectionStore(store as never, { config: async () => null })
    registry.store = sshStore
  })

  it('attaches to an environment recipe host the same way as a listed managed host', () => {
    const listed = sshStore.addTarget({ ...base, label: 'listed' })
    sshStore.getOrcadRuntimeClaims().claim(listed.id, 'env-listed', { ownerRecorded: false })
    servedEnvironment('env-listed', listed.id, listed.generation!)
    const recipe = sshStore.upsertRuntimeOwnedTarget('vm-1', { ...base, label: 'recipe' })
    sshStore.getOrcadRuntimeClaims().claim(recipe.id, 'env-recipe', { ownerRecorded: false })
    servedEnvironment('env-recipe', recipe.id, recipe.generation!)
    const connected = { getState: () => ({ status: 'connected' }) }

    expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: candidates read only status.
      listDesktopBrowserBridgeCandidates('/user-data', connected as never)
    ).toEqual([
      { environmentId: 'env-listed', targetId: listed.id, hostLabel: 'listed' },
      { environmentId: 'env-recipe', targetId: recipe.id, hostLabel: 'recipe' }
    ])
  })

  it('still skips a recipe host that serves no managed Orca server', () => {
    sshStore.upsertRuntimeOwnedTarget('vm-2', { ...base, label: 'unserved' })
    const connected = { getState: () => ({ status: 'connected' }) }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: candidates read only status.
    expect(listDesktopBrowserBridgeCandidates('/user-data', connected as never)).toEqual([])
  })
})
