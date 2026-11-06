import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { folderLineageEdgeOf } from '../../../../shared/worktree/folder-lineage-parents'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeStore } from '../../runtime-store-contract'
import { projectWorktreeLineageWithHostPeers } from '../../../workspaces/catalog/worktree-lineage-host-peers'

/** Each listed row with its own folder workspace parent, so a client merging hosts by raw id still
 * tells same-id rows on two machines apart. Rows without one carry null. */
export function withInlineFolderLineage<T extends Worktree>(
  store: Pick<RuntimeStore, 'getAllWorkspaceLineage'>,
  rows: readonly T[]
): (T & { workspaceLineage?: WorkspaceLineage | null })[] {
  const records = store.getAllWorkspaceLineage?.()
  if (!records) {
    return [...rows]
  }
  return rows.map((row) => {
    const record = records[worktreeWorkspaceKey(row.id)]
    return { ...row, workspaceLineage: folderLineageEdgeOf(record, row.instanceId) ? record : null }
  })
}

/** A runtime listing's rows with their lineage projected and their own folder parents attached. */
export function projectListedWorktreeLineage<T extends Worktree>(
  store: Parameters<typeof projectWorktreeLineageWithHostPeers>[0] &
    Pick<RuntimeStore, 'getAllWorkspaceLineage'>,
  repo: Repo,
  rows: readonly T[]
) {
  return withInlineFolderLineage(store, projectWorktreeLineageWithHostPeers(store, repo, rows))
}
