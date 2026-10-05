import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { normalizeTerminalChatPair } from '../../shared/terminal-tab-view-mode'
import { terminalLayoutNodeLeafIds } from '../../shared/native-chat-leaf-ownership'
import type {
  AgentExitRetirementCondition,
  AgentExitRetirementDisposition
} from '../../shared/agent-exit-retirement'
import type { HeadlessSessionTabProps } from './headless-session-tab-props-patch'
import { readHeadlessChatPairState } from './session-tab-chat-pair'

/**
 * What a headless host's agent-exit retirement may write, decided on persistence only (never a
 * published row): the pane's chat turns terminal and a sole pane's hint clears, unless the pane
 * was rebound or a client switched the tab after the exit was observed.
 */
export function resolveHeadlessAgentExitRetirement(args: {
  session: WorkspaceSessionState | null | undefined
  worktreeId: string
  parentTabId: string
  condition: AgentExitRetirementCondition
  stamp: { changedAtMs: number }
  /** This pane's current presentation token. */
  tokenFor: () => string
}): { disposition: AgentExitRetirementDisposition; props?: HeadlessSessionTabProps } {
  const { session, worktreeId, parentTabId, condition } = args
  const row = session?.tabsByWorktree[worktreeId]?.find((tab) => tab.id === parentTabId)
  if (!session || !row) {
    return { disposition: 'missing' }
  }
  const layout = session.terminalLayoutsByTabId?.[parentTabId]
  const leafIds = terminalLayoutNodeLeafIds(layout?.root)
  if (leafIds.length > 0 && !leafIds.includes(condition.leafId)) {
    return { disposition: 'missing' }
  }
  const soleLeaf = leafIds.length <= 1
  const boundPtyId =
    layout?.ptyIdsByLeafId?.[condition.leafId] ?? (soleLeaf ? row.ptyId : undefined)
  if (
    (condition.ptyId && boundPtyId && boundPtyId !== condition.ptyId) ||
    (condition.observedAtMs !== undefined && args.stamp.changedAtMs >= condition.observedAtMs) ||
    (condition.presentationToken !== undefined && condition.presentationToken !== args.tokenFor())
  ) {
    return { disposition: 'superseded' }
  }
  const state = readHeadlessChatPairState(session, undefined, worktreeId, parentTabId)
  const pair = normalizeTerminalChatPair(state?.pair ?? {}, layout?.root)
  const ownsChat =
    pair.viewMode === 'chat' && (pair.chatLeafId ? pair.chatLeafId === condition.leafId : soleLeaf)
  const clearHint = soleLeaf && Boolean(row.launchAgent)
  if (!ownsChat && !clearHint) {
    return { disposition: 'unchanged' }
  }
  return {
    disposition: 'applied',
    props: {
      ...(ownsChat ? { viewMode: 'terminal' as const } : {}),
      ...(ownsChat && layout ? { chatLeafId: null } : {}),
      ...(clearHint ? { launchAgent: null } : {})
    }
  }
}
