import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { isWorkspaceSleepRecord } from '../../../../../shared/workspace/lifecycle/workspace-sleep'

/** A mail wake main started for a slept pane: kept in the orchestration database, never on the sleep record. */
export type MailWakeCustody = {
  id: string
  startedAt: number
  attempt?: { ptyId: string; incarnationId: string; launchToken: string; startedAt: number }
}

/** The slept agent a wake resumes, with main's attempt when one was started. */
export type SleptMailRecord = SleepingAgentSessionRecord & { mailWake?: MailWakeCustody }

/** Custody is independent of whether its pane currently owns a shell. */
export function mailWakeObligation(record: SleptMailRecord | null | undefined) {
  if (!record) {
    return null
  }
  if (record.origin === 'worktree-sleep' && isWorkspaceSleepRecord(record)) {
    return 'manual' as const
  }
  if (record.mailWake) {
    return 'retained' as const
  }
  return record.origin === 'worktree-sleep' ? ('automatic' as const) : null
}

export function confirmsMailWake(
  record: SleptMailRecord,
  row: AgentStatusIpcPayload,
  currentPtyId: string | null | undefined
): boolean {
  const attempt = record.mailWake?.attempt
  return (
    mailWakeObligation(record) === 'retained' &&
    !!attempt &&
    currentPtyId === attempt.ptyId &&
    row.launchToken === attempt.launchToken &&
    row.connectionId === (record.connectionId ?? null) &&
    row.paneKey === record.paneKey &&
    !row.isReplay &&
    !row.restoredUnconfirmed &&
    !row.providerSessionOnly &&
    !row.programStatusOnly &&
    (row.observation?.origin === 'hook' || row.observation?.origin === 'osc') &&
    row.observation.kind !== 'snapshot' &&
    row.agentType === record.agent &&
    agentProviderSessionsEqual(record.agent, row.providerSession, record.providerSession)
  )
}

export function withoutMailWake(record: SleptMailRecord): SleepingAgentSessionRecord {
  const { mailWake: _settled, ...rest } = record
  return rest
}
