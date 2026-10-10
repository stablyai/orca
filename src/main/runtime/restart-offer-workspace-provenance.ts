import type { RestartOfferWorkspaceProvenance } from '../../shared/restart-offer-origin'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

/** The store reads this needs; the runtime's store provides them. */
type ProvenanceStore = {
  getWorktreeMeta: (
    worktreeId: string
  ) => Pick<WorktreeMeta, 'creatorProvenance' | 'automationProvenance'> | undefined
  getFolderWorkspaces?: () => readonly Pick<FolderWorkspace, 'id' | 'creatorProvenance'>[]
}

/** The creator and automation records of the workspace an offered chat ran in, as this host keeps
 *  them; undefined for one it has no record of (a repo's main checkout, a removed workspace). */
export function readRestartOfferWorkspaceProvenance(
  store: ProvenanceStore | null,
  workspaceId: string
): RestartOfferWorkspaceProvenance | undefined {
  if (!store) {
    return undefined
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const workspace = store
      .getFolderWorkspaces?.()
      .find((entry) => entry.id === scope.folderWorkspaceId)
    return workspace ? { creatorProvenance: workspace.creatorProvenance } : undefined
  }
  const meta = store.getWorktreeMeta(scope?.type === 'worktree' ? scope.worktreeId : workspaceId)
  return meta
    ? { creatorProvenance: meta.creatorProvenance, automationProvenance: meta.automationProvenance }
    : undefined
}
