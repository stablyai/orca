import { describe, expect, it } from 'vitest'
import { WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'
import { resolveFederatedChildParent } from './federated-worker-child-parent'

function resolve(serverCapabilities: string[]) {
  return resolveFederatedChildParent({
    runtime: {
      showTerminal: async () => ({ worktreeId: 'home-repo::/home/wt' }),
      getOrchestrationDispatchAuthority: () => null,
      showManagedWorktree: async () => ({
        id: 'home-repo::/home/wt',
        displayName: 'home-wt',
        instanceId: 'instance-home'
      }),
      readStoreInstallationId: async () => 'install-home'
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these runtime reads are used.
    } as unknown as Parameters<typeof resolveFederatedChildParent>[0]['runtime'],
    from: 'term_coordinator',
    callerSession: undefined,
    serverCapabilities,
    serverName: 'build-box'
  })
}

describe('remote new-child parent', () => {
  it('names the coordinator’s workspace by this store’s verified ids', async () => {
    await expect(resolve([WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY])).resolves.toEqual({
      crossStoreParent: {
        installationId: 'install-home',
        workspaceKey: 'worktree:home-repo::/home/wt',
        instanceId: 'instance-home'
      }
    })
  })

  it('starts top-level with a warning on a server too old to nest across machines', async () => {
    await expect(resolve([])).resolves.toEqual({
      warning:
        'Not nested under home-wt: build-box needs an Orca update to nest across machines, so the worktree was created top-level.'
    })
  })
})
