import { parsePaneKey } from '../../../shared/stable-pane-id'
import { orchestrationCompatibilityHostScopesEqual } from '../orchestration-compatibility-host-scope'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { CurrentTerminalMailboxAuthority } from './terminal-mailbox-subscriptions'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'

type SubscriptionPty = Pick<
  RuntimePtyWorktreeRecord,
  | 'ptyId'
  | 'paneKey'
  | 'tabId'
  | 'connected'
  | 'lastAgentStatus'
  | 'lastAgentStatusObservedLive'
  | 'lastOscTitle'
>

/** Reconstructs only an attested receiver surface; it never discovers or registers recipients. */
export function resolveTerminalMailboxSubscriptionLeaf(input: {
  binding: CurrentTerminalMailboxAuthority
  current: CurrentTerminalMailboxAuthority | null
  ptys: Iterable<SubscriptionPty>
  leaves: Iterable<OrchestrationMailboxLeaf>
  handleForPty: (ptyId: string) => string | undefined
  handleForLeaf: (tabId: string, leafId: string) => string | undefined
}): OrchestrationMailboxLeaf | null {
  const { binding, current } = input
  const pane = parsePaneKey(binding.paneKey)
  if (
    !pane ||
    !current ||
    current.terminalHandle !== binding.terminalHandle ||
    current.paneKey !== binding.paneKey ||
    current.ptyId !== binding.ptyId ||
    current.processIncarnation !== binding.processIncarnation ||
    !orchestrationCompatibilityHostScopesEqual(current.hostScope, binding.hostScope)
  ) {
    return null
  }

  const ptys = [...input.ptys].filter(
    (pty) => pty.ptyId === binding.ptyId || pty.paneKey === binding.paneKey
  )
  const pty = ptys[0]
  if (
    ptys.length !== 1 ||
    !pty?.connected ||
    pty.ptyId !== binding.ptyId ||
    pty.paneKey !== binding.paneKey ||
    pty.tabId !== pane.tabId
  ) {
    return null
  }

  const leaves = [...input.leaves].filter(
    (leaf) => leaf.ptyId === binding.ptyId || `${leaf.tabId}:${leaf.leafId}` === binding.paneKey
  )
  if (leaves.length > 1) {
    return null
  }
  const leaf = leaves[0]
  const ptyHandle = input.handleForPty(binding.ptyId)
  if (ptyHandle !== undefined && ptyHandle !== binding.terminalHandle) {
    return null
  }
  if (leaf) {
    return leaf.ptyId === binding.ptyId &&
      leaf.tabId === pane.tabId &&
      leaf.leafId === pane.leafId &&
      input.handleForLeaf(leaf.tabId, leaf.leafId) === binding.terminalHandle
      ? leaf
      : null
  }
  if (ptyHandle !== binding.terminalHandle) {
    return null
  }
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
