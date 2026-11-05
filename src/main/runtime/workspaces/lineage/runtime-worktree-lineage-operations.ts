import { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../../terminal/launch/terminal-workspace-scope'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type {
  WorktreeLineageInput,
  WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { resolveNestedWorkerMaxDepth } from '../../../../shared/nested-worker-depth'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { WorkspaceKey } from '../../../../shared/workspace-scope'
import type { Repo } from '../../../../shared/repo-types'
export abstract class RuntimeWorktreeLineageOperations extends OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree {
  /** `childRepo` scopes the parent to the new worktree's execution host (#12757). */
  protected resolveLineageForWorktreeCreate(
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

  hydrateInferredWorktreeLineage(): Promise<void> {
    return this.worktreeLineage.hydrate()
  }

  listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    return this.worktreeLineage.listWorktreeLineage()
  }

  listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    return this.worktreeLineage.listWorkspaceLineage()
  }
}
