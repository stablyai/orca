import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'

/** The mailbox pane a PTY record stands in for when no window leaf holds it. */
export function ptyMailboxLeaf(
  pane: { tabId: string; leafId: string },
  pty: Pick<
    RuntimePtyWorktreeRecord,
    'ptyId' | 'lastAgentStatus' | 'lastAgentStatusObservedLive' | 'lastOscTitle'
  >
): OrchestrationMailboxLeaf {
  return {
    tabId: pane.tabId,
    leafId: pane.leafId,
    ptyId: pty.ptyId,
    writable: true,
    lastAgentStatus: pty.lastAgentStatus,
    lastAgentStatusObservedLive: pty.lastAgentStatusObservedLive,
    lastOscTitle: pty.lastOscTitle
  }
}
