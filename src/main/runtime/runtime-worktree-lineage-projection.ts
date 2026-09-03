import { filterLineageForHost } from '../ipc/worktrees/metadata/workspace-lineage-filtering'
import type { Store } from '../persistence'
import type { ExecutionHostId } from '../../shared/execution-host'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { Worktree } from '../../shared/worktree/types'
import type { RuntimeStore } from './runtime-store-contract'

/** Project lineage using host-owned edges and live scan rows, never stale metadata instances. */
export function projectCurrentHostWorktreeLineage<T extends Worktree>(args: {
  worktrees: readonly T[]
  currentFleet: readonly Worktree[]
  store: RuntimeStore
  executionHostId: ExecutionHostId
}) {
  const filterStore = args.store as unknown as Store
  const lineage =
    typeof filterStore.getFolderWorkspaces === 'function' &&
    typeof filterStore.getProjectGroups === 'function'
      ? filterLineageForHost(filterStore, args.executionHostId)
      : {
          worktreeLineageById: args.store.getAllWorktreeLineage?.() ?? {},
          workspaceLineageByChildKey: args.store.getAllWorkspaceLineage?.() ?? {}
        }
  if (!lineage) {
    return projectResolvedWorktreeLineage(args.worktrees, {}, {})
  }
  const currentInstances = args.currentFleet.reduce<Record<string, (string | undefined)[]>>(
    (instances, worktree) => {
      if (worktree.hostId === args.executionHostId) {
        ;(instances[worktreeWorkspaceKey(worktree.id)] ??= []).push(worktree.instanceId)
      }
      return instances
    },
    {}
  )
  return projectResolvedWorktreeLineage(
    args.worktrees,
    lineage.worktreeLineageById,
    lineage.workspaceLineageByChildKey,
    currentInstances
  )
}
