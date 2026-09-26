import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import {
  createCrossMachineRecoveryHost,
  type CrossMachineRecoveryHost
} from './cross-machine-recovery/recovery-runtime-host'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

export class OrcaRuntimeWithCrossMachineRecoveryHost extends OrcaRuntimeWithResolveWaiter {
  // Why: addRepo is installed on the final runtime prototype, so callers holding that type supply it.
  getCrossMachineRecoveryHost(
    addRepo: CrossMachineRecoveryHost['addRepo']
  ): CrossMachineRecoveryHost {
    return createCrossMachineRecoveryHost({
      store: this.store,
      getAuthoritativeWindow: () => this.getAvailableAuthoritativeWindow(),
      getAgentStatusSnapshot: () => this.getAgentStatusSnapshotFn?.() ?? [],
      listLocalRepos: () =>
        this.listRepos().filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID),
      addRepo,
      invalidateWorktreeCatalog: (repoId) => this.invalidateWorktreeCatalog(repoId),
      resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
      ensureAgentSession: (request) => this.ensureAgentSession(request),
      activateWorktree: async (worktreeId) => {
        await this.activateManagedWorktree(`id:${worktreeId}`, { notifyClients: true })
      }
    })
  }
}
