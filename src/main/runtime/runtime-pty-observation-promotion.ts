import type { AgentStatus } from '../../shared/agent-detection'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import { terminalTitleBlocksExplicitAgentStatus } from './runtime-worktree-status-projection'
import type { PtyObservationStamp, PtyObservationTitle } from './runtime-pty-observation-admission'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

/** The record surfaces a promoted title writes to, resolved by the caller. */
export type PromotedPtyObservationTitleTarget = {
  pty: RuntimePtyWorktreeRecord | undefined
  leaves: Iterable<RuntimeLeafRecord>
  nextTitleObservationSequence: () => number
  setManagementTitle: (
    pty: RuntimePtyWorktreeRecord,
    normalizedTitle: string,
    observedAt: number
  ) => void
}

/**
 * Apply one promoted title as state. Deliberately omits every live-path side
 * effect — no exit confirmation, idle waiters, pending-message delivery,
 * foreground probe or mobile heartbeat — because promotion restores the
 * winning source's current state rather than replaying its history.
 */
export function applyPromotedPtyObservationTitle(
  title: PtyObservationTitle,
  stamp: PtyObservationStamp,
  target: PromotedPtyObservationTitleTarget
): AgentStatus | null {
  const { rawTitle, normalizedTitle, identityOnly } = title
  const recordedTitle = identityOnly ? null : normalizedTitle
  const agentStatus = identityOnly ? null : detectAgentStatusFromTitle(rawTitle)
  const observedAt = target.nextTitleObservationSequence()
  const observedAtEpochMs = identityOnly ? null : stamp.observedAtEpochMs
  const pty = target.pty
  if (pty) {
    pty.lastOscTitle = recordedTitle
    pty.lastOscTitleAt = identityOnly ? null : observedAt
    pty.lastOscTitleEpochMs = observedAtEpochMs
    pty.lastAgentStatus = agentStatus
    pty.lastAgentStatusObservedLive = true
    pty.lastAgentStatusStartedAtEpochMs = observedAtEpochMs
    if (identityOnly || terminalTitleBlocksExplicitAgentStatus(recordedTitle)) {
      pty.lastAgentStatusRichInvalidatedAtEpochMs = observedAtEpochMs ?? Date.now()
    }
    if (identityOnly) {
      pty.managementTitle = null
      pty.managementTitleAt = null
    } else {
      target.setManagementTitle(pty, normalizedTitle, observedAt)
    }
  }
  for (const leaf of target.leaves) {
    leaf.lastOscTitle = recordedTitle
    leaf.lastOscTitleAt = identityOnly ? null : target.nextTitleObservationSequence()
    leaf.lastAgentStatus = agentStatus
    leaf.lastAgentStatusObservedLive = true
  }
  return agentStatus
}
