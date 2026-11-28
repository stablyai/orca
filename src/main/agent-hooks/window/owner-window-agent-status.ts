// The one rule for which agent statuses the owner's window hears, pushed or pulled: a teammate's own
// terminal in a shared agent's Home reports to their own devices, never to the owner's window or the
// paired clients it relays to. A status no list places reaches no one.
import type { TabListRef } from '../../bots/team-share/teammate-rules'
import { getPtyIdForPaneKey } from '../../ipc/pty/pane/key-state'
import { hostListPty, windowOwns } from '../../runtime/session-tabs/person/person-workspace-target'
import { inHostListPane } from '../../runtime/terminal/output/terminal-tab-list-classification'
import type { RuntimePtyWorktreeRecord } from '../../runtime/terminal/records/runtime-terminal-state-records'

export type OwnerWindowAgentStatusRuntime = {
  ptyRecordOf(ptyId: string): Pick<RuntimePtyWorktreeRecord, 'holder' | 'worktreeId'> | undefined
  getStatusTabList(identity: { paneKey: string; worktreeId?: string }): TabListRef | null
}

/** A status names its workspace, its pane, or a terminal (named, or bound to the pane by the
 *  provider, which a tab close outlives): the terminal's list decides while it lives, else the list
 *  the pane is in, as the host's sidebar and notifications read it. A host with no runtime has no
 *  teammates. */
export function ownerWindowShowsAgentPane(
  runtime: Partial<OwnerWindowAgentStatusRuntime> | null | undefined,
  identity: { paneKey?: string; ptyId?: string; worktreeId?: string }
): boolean {
  if (!runtime?.ptyRecordOf || !runtime.getStatusTabList) {
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
  const { paneKey } = identity
  const statusTabList = runtime.getStatusTabList.bind(runtime)
  return paneKey
    ? inHostListPane(paneKey, () => statusTabList({ paneKey, worktreeId: identity.worktreeId }))
    : false
}

// The panes and terminals the window was told of: a clear reaches it for those, even once nothing
// places them any more (a torn-down alias, a terminal gone), and for nothing else.
const shownPanes = new Set<string>()
const shownMigrationPtys = new Set<string>()

/** Whether the owner's window hears a pane's status, pushed or pulled; it then hears its clear. */
export function ownerWindowHearsStatus(
  runtime: Partial<OwnerWindowAgentStatusRuntime> | null | undefined,
  status: { paneKey: string; worktreeId?: string }
): boolean {
  const shown = ownerWindowShowsAgentPane(runtime, status)
  if (shown) {
    shownPanes.add(status.paneKey)
  }
  return shown
}

export function ownerWindowHearsClear(
  runtime: Partial<OwnerWindowAgentStatusRuntime> | null | undefined,
  clear: { paneKey: string }
): boolean {
  return shownPanes.delete(clear.paneKey) || ownerWindowShowsAgentPane(runtime, clear)
}

/** Whether the owner's window hears a terminal's migration notice; it then hears its clear. */
export function ownerWindowHearsMigrationNotice(
  runtime: Partial<OwnerWindowAgentStatusRuntime> | null | undefined,
  entry: { ptyId: string; worktreeId?: string; tabId?: string; leafId?: string; paneKey?: string }
): boolean {
  const paneKey =
    entry.paneKey ?? (entry.tabId && entry.leafId ? `${entry.tabId}:${entry.leafId}` : undefined)
  const shown = ownerWindowShowsAgentPane(runtime, {
    ptyId: entry.ptyId,
    ...(entry.worktreeId ? { worktreeId: entry.worktreeId } : {}),
    ...(paneKey ? { paneKey } : {})
  })
  if (shown) {
    shownMigrationPtys.add(entry.ptyId)
  }
  return shown
}

export function ownerWindowHearsMigrationClear(
  runtime: Partial<OwnerWindowAgentStatusRuntime> | null | undefined,
  ptyId: string
): boolean {
  return shownMigrationPtys.delete(ptyId) || ownerWindowShowsAgentPane(runtime, { ptyId })
}
