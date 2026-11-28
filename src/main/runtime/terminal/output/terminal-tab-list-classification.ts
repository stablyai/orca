// Every terminal fact is classified once, where it is made, by the tab list it is in: the host
// list's go to the owner's window, sidebar, notifications and devices, and a teammate's own (in a
// shared agent's Home) to their devices alone. A fact whose list is unknown goes to neither.
import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import { structuredAgentSessionIdOfTab } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { TabListRef } from '../../../bots/team-share/teammate-rules'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { tabListOfPty } from '../../session-tabs/person/person-workspace-target'

/** The tab list a client event is about: undefined for none, null when unknown. */
export function clientEventTabList(
  event: RuntimeClientEvent,
  ptyOf: (ptyId: string) => RuntimePtyWorktreeRecord | undefined
): string | null | undefined {
  if (event.type === 'terminalSideEffects') {
    const pty = ptyOf(event.batch.ptyId)
    return pty ? tabListOfPty(pty) : null
  }
  return event.type === 'worktreeTerminalSleepState' ? event.worktreeId : undefined
}

/** Whether a hook-reported pane is a host list's: a chat's always is; a terminal's when a host list
 *  places it, never when a teammate's does or nothing does (`getStatusTabList`). */
export function inHostListPane(
  paneKey: string,
  statusTabList: (identity: { paneKey: string }) => TabListRef | null
): boolean {
  const pane = parsePaneKey(paneKey)
  if (pane && structuredAgentSessionIdOfTab(pane.tabId) !== null) {
    return true
  }
  const list = statusTabList({ paneKey })
  return list !== null && list.holder === undefined
}
