import type { WorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

/** Deletes from `saved` every link in `links` that matches, saving if any went; returns the children it released. */
export function releaseMatchingLineage<L extends { childWorkspaceKey: WorkspaceKey }>(
  saved: Record<string, unknown> | undefined,
  links: readonly L[],
  matches: (lineage: L) => boolean,
  save: () => void
): WorkspaceKey[] {
  const released = links.filter(matches).map((lineage) => lineage.childWorkspaceKey)
  for (const childKey of released) {
    delete saved?.[childKey]
  }
  if (released.length > 0) {
    save()
  }
  return released
}
