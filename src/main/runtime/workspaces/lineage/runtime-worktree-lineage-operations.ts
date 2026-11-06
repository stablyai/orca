import { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../../terminal/launch/terminal-workspace-scope'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type {
  WorktreeLineageInput,
  WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { resolveNestedWorkerMaxDepth } from '../../../../shared/nested-worker-depth'
import type { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import type {
  CrossStoreWorkspaceLineage,
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../shared/worktree/lineage-types'
import type { WorkspaceKey } from '../../../../shared/workspace-scope'
import type { Repo } from '../../../../shared/repo-types'
export abstract class RuntimeWorktreeLineageOperations extends OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree {
  /** `childRepo` scopes the parent to the new worktree's execution host (#12757). */
  resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput,
    childRepo?: Repo
  ): Promise<WorktreeLineageResolution> {
    return this.worktreeLineage.resolveCreate(
      input,
      childRepo ? getRepoExecutionHostId(childRepo) : undefined
    )
  }

  protected getOrchestrationDbIfAvailable(): OrchestrationDb | null {
    return this._orchestrationDb
  }

  getNestedWorkerMaxDepth(): number {
    return resolveNestedWorkerMaxDepth({
      nestedWorkerMaxDepth: this.store?.getSettings?.()?.nestedWorkerMaxDepth
    })
  }

  listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    return this.worktreeLineage.listWorktreeLineage()
  }

  listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    return this.worktreeLineage.listWorkspaceLineage()
  }

  listCrossStoreLineage(): Record<WorkspaceKey, CrossStoreWorkspaceLineage> {
    return this.store?.getAllCrossStoreWorkspaceLineage?.() ?? {}
  }

  resolveCallerParentForAnotherStore(
    ...args: Parameters<RuntimeWorktreeLineageController['resolveCallerParentForAnotherStore']>
  ): ReturnType<RuntimeWorktreeLineageController['resolveCallerParentForAnotherStore']> {
    return this.worktreeLineage.resolveCallerParentForAnotherStore(...args)
  }

  /** This store's installationId; cross-store records name their parent's store by it. */
  readStoreInstallationId(): Promise<string | undefined> {
    return this.worktreeLineage.readStoreInstallationId()
  }
}
