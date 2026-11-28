// A teammate's own terminal in a shared agent's Home is theirs: its bells, titles and agent turns go
// to their devices, never to the owner's sidebar or notifications, which read the host lists' alone.
import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { TerminalSideEffectBatch } from '../../../../shared/terminal/output/terminal-side-effect-facts'
import { structuredAgentSessionIdOfTab } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { TabListRef } from '../../../bots/team-share/teammate-rules'
import { ptyInList, type RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

/** The host lists' terminal side effects, from the runtime's client events. */
export function hostListTerminalSideEffects(
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: true }
  ) => () => void,
  ptyOf: (ptyId: string) => RuntimePtyWorktreeRecord | undefined
): (listener: (batch: TerminalSideEffectBatch) => void) => () => void {
  return (listener) =>
    onClientEvent(
      (event) => {
        if (event.type === 'terminalSideEffects' && ptyInList(ptyOf(event.batch.ptyId), 'host')) {
          listener(event.batch)
        }
      },
      { consumesTerminalSideEffects: true }
    )
}

/** Whether a pane is a host list's: a chat's always is; a terminal's unless a teammate's list holds it. */
export function inHostListPane(
  paneKey: string,
  statusTabList: (identity: { paneKey: string }) => TabListRef | null
): boolean {
  const pane = parsePaneKey(paneKey)
  return (
    !pane ||
    structuredAgentSessionIdOfTab(pane.tabId) !== null ||
    statusTabList({ paneKey })?.holder === undefined
  )
}
