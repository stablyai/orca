import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { AgentHookEventPayload } from '../../../../shared/agent-hook-listener/listener-event'
import { markAntigravityDoneRetried } from './hook-precedence'
import type { PaneTimers } from './pane-timers'

/** Re-offer a yielding OSC 7501 report after delayMs, only against the hook observation it yielded to. */
export function deferProgramStatusRecheck<E extends { paneKey: string; tabId?: string }>(input: {
  rechecks: PaneTimers
  rows: ReadonlyMap<string, AgentHookEventPayload>
  paneKey: string
  yieldedTo: number | undefined
  delayMs: number | undefined
  event: E
  reoffer: (event: E) => void
}): void {
  const { yieldedTo, delayMs, event } = input
  if (yieldedTo === undefined || delayMs === undefined) {
    input.rechecks.cancel(input.paneKey)
    return
  }
  input.rechecks.defer(input.paneKey, delayMs + 1, (currentPaneKey) => {
    const row = input.rows.get(currentPaneKey)
    if (
      row &&
      row.providerSessionOnly !== true &&
      'receivedAt' in row &&
      row.receivedAt === yieldedTo
    ) {
      const tabId = parsePaneKey(currentPaneKey)?.tabId ?? event.tabId
      input.reoffer(markAntigravityDoneRetried({ ...event, paneKey: currentPaneKey, tabId }))
    }
  })
}
