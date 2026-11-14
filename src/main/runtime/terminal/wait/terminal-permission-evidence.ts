import type { RuntimeTerminalAgentStatusSnapshot } from '../query/runtime-terminal-agent-status-query'
import type { AgentStatus } from '../../../../shared/agent-status/title/agent-title-core'
import { isOpenCodeNativeTitle } from '../../../../shared/agent-status/title/providers/opencode-terminal-title'
import {
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason
} from './terminal-wait-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-terminal-contracts'

export type TerminalPermissionDecision =
  | { kind: 'none' }
  | { kind: 'current' | 'superseded' | 'unresolved'; reason: RuntimeTerminalWaitBlockedReason }

export function resolveTerminalPermissionEvidence(
  terminal: RuntimeTerminalAgentStatusSnapshot,
  explicitStatus: { status: AgentStatus; updatedAt: number } | null,
  lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined,
  observedOnScreen = false
) {
  const decision = judgeTerminalPermissionEvidence(
    terminal,
    explicitStatus,
    lifecycle,
    observedOnScreen
  )
  return decision.kind === 'current' ? decision.reason : null
}

export function judgeTerminalPermissionEvidence(
  terminal: RuntimeTerminalAgentStatusSnapshot,
  explicitStatus: { status: AgentStatus; updatedAt: number } | null,
  lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined,
  observedOnScreen = false,
  candidate?: RuntimeTerminalWaitBlockedReason
): TerminalPermissionDecision {
  const blockedByWaitText =
    candidate ?? detectTerminalWaitBlockedReason(terminal.waitText, terminal.waitTextSupport)
  if (!blockedByWaitText) {
    return { kind: 'none' }
  }
  const liveTitleClearsBlockedText =
    terminal.titleStatusIsLive &&
    terminal.titleStatus !== null &&
    terminal.titleStatus !== 'permission' &&
    (!observedOnScreen ||
      terminal.titleStatus !== 'idle' ||
      detectExplicitIdleStatusFromTitle(terminal.title ?? '') === 'idle') &&
    !isOpenCodeNativeTitle(terminal.title) &&
    blockedByWaitText !== 'agent-approval-prompt'
  if (observedOnScreen || blockedByWaitText === 'agent-approval-prompt') {
    return { kind: 'current', reason: blockedByWaitText }
  }
  const newestPermissionAt = Math.max(
    explicitStatus?.status === 'permission' ? explicitStatus.updatedAt : -1,
    lifecycle?.status === 'permission' ? lifecycle.updatedAt : -1,
    terminal.waitBlockedAt ?? -1
  )
  const newestClearAt = Math.max(
    explicitStatus && explicitStatus.status !== 'permission' ? explicitStatus.updatedAt : -1,
    lifecycle?.status && lifecycle.status !== 'permission' ? lifecycle.updatedAt : -1
  )
  if (newestPermissionAt >= 0 && newestPermissionAt >= newestClearAt) {
    return { kind: 'current', reason: blockedByWaitText }
  }
  if (
    newestClearAt >= 0 ||
    (liveTitleClearsBlockedText && lifecycle?.status !== terminal.titleStatus)
  ) {
    return { kind: 'superseded', reason: blockedByWaitText }
  }
  return { kind: 'unresolved', reason: blockedByWaitText }
}
