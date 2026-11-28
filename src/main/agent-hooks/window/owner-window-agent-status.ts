// The one rule for which agent statuses the owner's window hears, pushed or pulled: a teammate's own
// terminal in a shared agent's Home reports to their own devices, never to the owner's window or the
// paired clients it relays to. Every other status is the owner's.
import { getPtyIdForPaneKey } from '../../ipc/pty/pane/key-state'
import { hostListPty, windowOwns } from '../../runtime/session-tabs/person/person-workspace-target'
import type { RuntimePtyWorktreeRecord } from '../../runtime/terminal/records/runtime-terminal-state-records'

export type OwnerWindowAgentStatusRuntime = {
  ptyRecordOf(ptyId: string): Pick<RuntimePtyWorktreeRecord, 'holder' | 'worktreeId'> | undefined
  teammateListHoldsPane(paneKey: string): boolean
}

/** A status names its workspace, its pane, or a terminal (named, or bound to the pane by the
 *  provider, which a tab close outlives): the terminal's list decides while it lives, else whether a
 *  teammate's list holds the pane. A host with no runtime has no teammates. */
export function ownerWindowShowsAgentPane(
  runtime: Partial<OwnerWindowAgentStatusRuntime> | null | undefined,
  identity: { paneKey?: string; ptyId?: string; worktreeId?: string }
): boolean {
  if (!runtime?.ptyRecordOf || !runtime.teammateListHoldsPane) {
    return true
  }
  if (identity.worktreeId && !windowOwns(identity.worktreeId)) {
    return false
  }
  const ptyId = identity.ptyId ?? (identity.paneKey ? getPtyIdForPaneKey(identity.paneKey) : null)
  const pty = ptyId ? runtime.ptyRecordOf(ptyId) : undefined
  if (pty) {
    return hostListPty(pty)
  }
  return !identity.paneKey || !runtime.teammateListHoldsPane(identity.paneKey)
}

/** Whether the owner's window hears a terminal's migration notice. */
export function ownerWindowHearsMigrationNotice(
  runtime: Partial<OwnerWindowAgentStatusRuntime> | null | undefined,
  entry: { ptyId: string; worktreeId?: string; tabId?: string; leafId?: string; paneKey?: string }
): boolean {
  const paneKey =
    entry.paneKey ?? (entry.tabId && entry.leafId ? `${entry.tabId}:${entry.leafId}` : undefined)
  return ownerWindowShowsAgentPane(runtime, {
    ptyId: entry.ptyId,
    ...(entry.worktreeId ? { worktreeId: entry.worktreeId } : {}),
    ...(paneKey ? { paneKey } : {})
  })
}
