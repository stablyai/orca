import type { WorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import { preserveFolderLineageUncertainty } from '../../../../shared/worktree/lineage/lineage-uncertainty'

/** `keepFolderUncertainty`: a released folder-parent link first leaves an uncertainty marker, so a
 *  child that survives its parent stays unknown to report checks rather than reading as outside. */
export type LineageReleaseOptions = { keepFolderUncertainty?: boolean }

/** Deletes from `saved` every link in `links` that matches, saving if any went; returns the children it
 *  released. `beforeDelete` runs for each released link before any is deleted, in the same mutation and
 *  save, so evidence it records cannot be lost while the link it replaces survives. */
export function releaseMatchingLineage<L extends { childWorkspaceKey: WorkspaceKey }>(
  saved: Record<string, unknown> | undefined,
  links: readonly L[],
  matches: (lineage: L) => boolean,
  save: () => void,
  beforeDelete?: (lineage: L) => void
): WorkspaceKey[] {
  const matched = links.filter(matches)
  if (beforeDelete) {
    matched.forEach(beforeDelete)
  }
  const released = matched.map((lineage) => lineage.childWorkspaceKey)
  for (const childKey of released) {
    delete saved?.[childKey]
  }
  if (released.length > 0) {
    save()
  }
  return released
}

/** Drops the same-store workspace rows that match; returns the children it released. */
export function releaseWorkspaceLineageRows(
  state: Pick<
    PersistedState,
    'workspaceLineageByChildKey' | 'workspaceLineageUncertaintyByChild' | 'worktreeMeta' | 'repos'
  >,
  matches: (lineage: WorkspaceLineage) => boolean,
  options: LineageReleaseOptions | undefined,
  save: () => void
): WorkspaceKey[] {
  const links = state.workspaceLineageByChildKey
  return releaseMatchingLineage(
    links,
    Object.values(links),
    matches,
    save,
    options?.keepFolderUncertainty
      ? (lineage) => preserveFolderLineageUncertainty(state, lineage.childWorkspaceKey)
      : undefined
  )
}
