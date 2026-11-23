// Computes the published usageLimitContinue status summary, merging host-side bot backup failover state.
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionBotBackupState } from '../host/structured-agent-session-host-types'
import {
  USAGE_LIMIT_CONTINUE_CHAIN_LIMIT,
  type HostUsageLimitCut
} from './structured-agent-session-usage-limit-chain'

export function projectUsageLimitContinueSummary(input: {
  read: HostUsageLimitCut | null
  cut: { turnItemId: string; resetsAt: number; chain: number } | null
  hold: { unknownReset: boolean; resetsAt: number } | null
  cancels: boolean
  attemptFailed: boolean
  eligible: boolean
  backup: StructuredAgentSessionBotBackupState | undefined
}): AgentSessionStatusSummary['usageLimitContinue'] {
  const { read, cut, hold, cancels, attemptFailed, eligible, backup } = input
  if (!cut || !hold) {
    if (!read || !backup) {
      return undefined
    }
    return {
      turnItemId: read.turnItemId,
      resetsAt: backup.backupResetsAt ?? read.resetsAt ?? 0,
      state: 'off',
      backupState: backup.backupState,
      ...(backup.backupResetsAt !== undefined ? { backupResetsAt: backup.backupResetsAt } : {})
    }
  }
  const state = cancels
    ? 'cancelled'
    : cut.chain >= USAGE_LIMIT_CONTINUE_CHAIN_LIMIT || attemptFailed
      ? 'failed'
      : eligible
        ? 'scheduled'
        : 'off'
  // An unknown reset has no time to promise, yet fresh room still releases it: say nothing.
  if (hold.unknownReset && state === 'scheduled' && !backup) {
    return undefined
  }
  return {
    turnItemId: cut.turnItemId,
    resetsAt: cut.resetsAt,
    // While the reset is unknown, `hold.resetsAt` is a reading time, not a reset.
    ...(!hold.unknownReset && hold.resetsAt !== cut.resetsAt ? { continueAt: hold.resetsAt } : {}),
    state,
    ...(backup
      ? {
          backupState: backup.backupState,
          ...(backup.backupResetsAt !== undefined ? { backupResetsAt: backup.backupResetsAt } : {})
        }
      : {})
  }
}
