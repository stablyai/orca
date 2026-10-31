import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import {
  isWorkspacePresentationKey,
  type WorkspacePresentation,
  type WorkspacePresentationCommit,
  type WorkspacePresentationDocuments
} from '../../shared/workspace-presentation'
import type { ExecutionHostId } from '../../shared/execution-host'

/** A held source partition also holds its presentation and compatibility checkpoint. */
export function admittedWindowPresentationCommit(
  commit: WorkspacePresentationCommit,
  stored: WorkspacePresentationDocuments,
  isHeld: (hostId?: ExecutionHostId) => boolean
): WorkspacePresentationCommit {
  const owner = ORCA_LAYOUT_OWNER_IS_MAIN ? 'main' : 'window'
  const accepts = (document: WorkspacePresentation) =>
    document.owner === owner &&
    !isHeld(document.anchor.hostId) &&
    document.baseline.every(({ source }) => !isHeld(source.hostId))
  const presentations: WorkspacePresentationDocuments = {}
  for (const [key, document] of Object.entries(commit.presentations)) {
    const previous = isWorkspacePresentationKey(key) ? stored[key] : undefined
    if (
      document &&
      isWorkspacePresentationKey(key) &&
      accepts(document) &&
      (!previous || accepts(previous))
    ) {
      const incomingGroups = new Map(document.groups.map((group) => [group.id, group]))
      // Main owns structure; a lagging window contributes only its current selection/MRU.
      presentations[key] =
        ORCA_LAYOUT_OWNER_IS_MAIN && previous
          ? {
              ...previous,
              activeGroupId: previous.groups.some((group) => group.id === document.activeGroupId)
                ? document.activeGroupId
                : previous.activeGroupId,
              groups: previous.groups.map((group) => {
                const incoming = incomingGroups.get(group.id)
                const ids = new Set(group.tabOrder)
                return incoming
                  ? {
                      ...group,
                      activeTabId:
                        incoming.activeTabId && ids.has(incoming.activeTabId)
                          ? incoming.activeTabId
                          : group.activeTabId,
                      recentTabIds: incoming.recentTabIds?.filter((id) => ids.has(id))
                    }
                  : group
              })
            }
          : document
    }
  }
  const removed = new Set(commit.removedPresentations ?? [])
  if (commit.replacePresentations) {
    for (const key of Object.keys(stored)) {
      if (isWorkspacePresentationKey(key) && !commit.presentations[key]) {
        removed.add(key)
      }
    }
  }
  return {
    ...commit,
    presentations,
    sessions: commit.sessions.filter(({ hostId }) => !isHeld(hostId)),
    replacePresentations: false,
    removedPresentations: [...removed].filter((key) => {
      const document = stored[key]
      return document ? accepts(document) && !ORCA_LAYOUT_OWNER_IS_MAIN : true
    })
  }
}
