// Where a hook-reported pane with no live PTY or window pane sits, so its status reaches only the
// list holding it: a host list's snapshot or saved session, or a teammate's own workspace.
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { parsePersonWorkspaceKey } from '../../../../shared/workspace/identity/person-workspace-key'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { teammateTabListKey, type TabListRef } from '../../../bots/team-share/teammate-rules'
import { mobileTerminalTabPaneKey } from '../../session-lifecycle/projection/runtime-mobile-session-projection'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

/** The workspace whose live snapshot holds a terminal tab by this pane key (a sleeping or restored
 *  one with no PTY or window pane, or a legacy numeric pane). */
export function snapshotHoldingPane(
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>,
  paneKey: string,
  worktreeId?: string
): string | null {
  const candidates = worktreeId ? [worktreeId] : [...snapshots.keys()]
  return (
    candidates.find((candidate) =>
      snapshots
        .get(candidate)
        ?.tabs.some((tab) => tab.type === 'terminal' && mobileTerminalTabPaneKey(tab) === paneKey)
    ) ?? null
  )
}

/** The workspace an execution host's saved session lists this pane's terminal tab in: an owner's
 *  restored terminal before a window or snapshot shows it. A teammate's is never saved there. */
export function savedHostSessionHoldingPane(
  store: Pick<RuntimeStore, 'getWorkspaceSession' | 'getWorkspaceSessionHostIds'> | null,
  paneKey: string,
  worktreeId?: string
): string | null {
  const pane = parsePaneKey(paneKey)
  if (!pane || !store?.getWorkspaceSession) {
    return null
  }
  for (const hostId of store.getWorkspaceSessionHostIds?.() ?? ['local' as const]) {
    const tabsByWorktree = store.getWorkspaceSession(hostId).tabsByWorktree ?? {}
    const found = (worktreeId ? [worktreeId] : Object.keys(tabsByWorktree)).find((id) =>
      tabsByWorktree[id]?.some((tab) => tab.id === pane.tabId)
    )
    if (found) {
      return found
    }
  }
  return null
}

/** The list a workspace's tabs are: a teammate's own workspace is their list in their agent's Home. */
export function tabListRefOfWorkspace(workspaceId: string): TabListRef {
  const person = parsePersonWorkspaceKey(workspaceId)
  return person
    ? {
        workspaceId: folderWorkspaceKey(person.folderWorkspaceId),
        holder: teammateTabListKey(person)
      }
    : { workspaceId, holder: undefined }
}
