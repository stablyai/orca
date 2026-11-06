import type {
  BrowserAgentActivityEvent,
  BrowserAgentCursorEvent,
  BrowserAgentViewportEvent
} from '../../../shared/browser-agent-activity-contract'

/** window.api.browser members through which main shows an agent driving a page. */
export type BrowserAgentPresenceApi = {
  /** Main asks the pane to keep the user's focus through an agent press; `ready` answers it. */
  onAgentInputFocusGuard: (
    callback: (data: { browserPageId: string; token: string; active: boolean }) => void
  ) => () => void
  agentInputFocusGuardReady: (token: string, composing: boolean) => void
  /** Main marks the pages an agent drives; the tab strip badges them. */
  onAgentActivity: (callback: (data: BrowserAgentActivityEvent) => void) => () => void
  /** Main shows the agent's pointer before its input; `agentCursorArrived` answers awaited moves. */
  onAgentCursor: (callback: (data: BrowserAgentCursorEvent) => void) => () => void
  agentCursorArrived: (sequence: number) => void
  /** The pane sizes its page box to an agent's viewport, as a preset does. */
  onAgentViewportApplied?: (callback: (data: BrowserAgentViewportEvent) => void) => () => void
}
