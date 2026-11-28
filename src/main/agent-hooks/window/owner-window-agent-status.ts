// The one rule for which agent statuses the owner's window hears, pushed or pulled: a teammate's own
// terminal in a shared agent's Home reports to their own devices, never to the owner's window or the
// paired clients it relays to.
import { getPtyIdForPaneKey } from '../../ipc/pty/pane/key-state'
import { windowOwns } from '../../runtime/session-tabs/person/person-workspace-target'

export type OwnerWindowAgentStatusRuntime = {
  tabListOfPtyId(ptyId: string): string | null
  getStatusTabList(identity: { paneKey: string; worktreeId?: string }): { holder?: string } | null
}

/** By the PTY's list while it lives (named, or bound to the pane by the provider, which a tab
 *  close outlives), else by the list the status row is in, as the host's sidebar reads it. */
export function ownerWindowShowsAgentPane(
  runtime: Partial<OwnerWindowAgentStatusRuntime> | null | undefined,
  identity: { paneKey?: string; ptyId?: string; worktreeId?: string }
): boolean {
  const ptyId = identity.ptyId ?? (identity.paneKey ? getPtyIdForPaneKey(identity.paneKey) : null)
  const list = ptyId ? runtime?.tabListOfPtyId?.(ptyId) : null
  if (list) {
    return windowOwns(list)
  }
  const status = identity.paneKey
    ? runtime?.getStatusTabList?.({ paneKey: identity.paneKey, worktreeId: identity.worktreeId })
    : null
  return status?.holder === undefined
}
