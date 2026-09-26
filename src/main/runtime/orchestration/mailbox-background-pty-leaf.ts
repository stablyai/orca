import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { AgentStatus } from '../../../shared/agent-detection'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'

export type BackgroundPtyMailboxSource = {
  ptyId: string
  connected: boolean
  tabId: string | null
  paneKey: string | null
  lastAgentStatus: AgentStatus | null
  lastAgentStatusObservedLive: boolean
  lastOscTitle: string | null
  managementTitle: string | null
  title: string | null
}

// Why: background CLI PTYs keep a real pane key on the PTY record, but the
// handle identity is synthetic (`tabId` `pty:<id>`) and never mints a leaf.
export function mailboxLeafFromBackgroundPty(
  pty: BackgroundPtyMailboxSource
): OrchestrationMailboxLeaf | null {
  if (!pty.connected || !pty.tabId || !pty.paneKey) {
    return null
  }
  const parsed = parsePaneKey(pty.paneKey)
  if (!parsed || parsed.tabId !== pty.tabId) {
    return null
  }
  return {
    tabId: parsed.tabId,
    leafId: parsed.leafId,
    ptyId: pty.ptyId,
    writable: true,
    lastAgentStatus: pty.lastAgentStatus,
    lastAgentStatusObservedLive: pty.lastAgentStatusObservedLive,
    lastOscTitle: pty.lastOscTitle,
    paneTitle: pty.managementTitle ?? pty.title
  }
}

export function mailboxLeafForBackgroundPtyKey(
  leafKey: string,
  ptys: Iterable<BackgroundPtyMailboxSource>,
  leafKeyOf: (tabId: string, leafId: string) => string
): OrchestrationMailboxLeaf | null {
  for (const pty of ptys) {
    const leaf = mailboxLeafFromBackgroundPty(pty)
    if (leaf && leafKeyOf(leaf.tabId, leaf.leafId) === leafKey) {
      return leaf
    }
  }
  return null
}
