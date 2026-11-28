import type { useAppStore } from '@/store'
import { CHAT_PANE_ADDRESS_PREFIX } from '../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentAttentionSurface } from '@/attention/agent-attention-contract'
import {
  computeAgentAcknowledgementTargets,
  readManualUnreadProtectionTurn,
  resolveViewedUnreadSubjectKey,
  type AgentAttentionTurnRecords
} from '@/attention/agent-attention-acknowledgement'
import { createTerminalAttentionSurface } from '@/components/terminal-pane/notifications/terminal-attention-surface'
import { createStructuredAttentionSurface } from '@/components/native-chat/session/attention/structured-attention-surface'
import type { AutoAckTabTarget } from './agent-auto-ack-targets'
import { readWebChatMark } from '@/store/slices/agent-status/structured-sessions/chat-read-mark-aliases'
import {
  emitAgentSubjectReads,
  type AgentSubjectRead
} from '@/attention/agent-subject-read-actions'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

/** The adapter that owns a target's address; terminal and structured tab ids never mix. */
export function surfaceForAutoAckTarget(
  state: StoreSnapshot,
  target: AutoAckTabTarget
): AgentAttentionSurface {
  return target.surfaceKind === 'structured'
    ? createStructuredAttentionSurface(state)
    : createTerminalAttentionSurface(state)
}

export function readAgentAttentionTurnRecords(state: StoreSnapshot): AgentAttentionTurnRecords {
  return {
    liveTurns: state.agentStatusByPaneKey,
    acknowledgedTurnStartedAt: state.acknowledgedAgentsByPaneKey
  }
}

/** Acknowledge the one subject a viewed target shows, leaving hidden siblings' attention alone. */
export function acknowledgeViewedAutoAckTarget(
  state: StoreSnapshot,
  target: AutoAckTabTarget,
  options?: { reads?: readonly AgentSubjectRead[]; readViewed?: boolean }
): void {
  const records = readAgentAttentionTurnRecords(state)
  const groupId = target.tabId
  const subjectKey = surfaceForAutoAckTarget(state, target).resolveViewedSubjectKey(groupId)
  const turn = subjectKey === null ? null : readManualUnreadProtectionTurn(records, subjectKey)
  const protectedTurn =
    subjectKey !== null &&
    (turn !== null || subjectKey.startsWith(CHAT_PANE_ADDRESS_PREFIX)) &&
    readWebChatMark(state, 'manuallyUnreadTurnsByPaneKey', subjectKey, turn ?? undefined) !==
      undefined
  const toAck = protectedTurn ? [] : computeAgentAcknowledgementTargets(records, subjectKey)
  const viewedUnreadSubjectKey = resolveViewedUnreadSubjectKey(
    state.unreadAgentCompletionPanes,
    subjectKey
  )
  const readViewed = options?.readViewed && subjectKey !== null && !protectedTurn
  if (toAck.length === 0 && !viewedUnreadSubjectKey && !readViewed) {
    return
  }
  const clearedSubjectKeys = new Set(toAck)
  if (viewedUnreadSubjectKey) {
    clearedSubjectKeys.add(viewedUnreadSubjectKey)
  }
  if (readViewed && subjectKey) {
    clearedSubjectKeys.add(subjectKey)
  }
  emitAgentSubjectReads([...clearedSubjectKeys], options?.reads)
  // Why ack only: the tab's unread markers are read by `readOnScreenAttention` in the same scan.
  if (toAck.length > 0) {
    state.acknowledgeAgents(toAck, [])
  }
}
