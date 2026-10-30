import {
  liveResumeRecord,
  statusRetainsResumableIdentity,
  type ResumeRecordTab
} from '../../../../shared/agent-resume-record-from-status'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import { isLocalHookConnectionId } from '../../../../shared/wsl-hook-relay-contract'
import { resumeStatusFromHookRow } from '../../terminal/stop/hook-status-resume-records'

/** A row this host's own pane wrote for this workspace; a relayed SSH row names another host's transcript. */
export function isPaneLocalHookRow(row: AgentStatusIpcPayload, worktreeId: string): boolean {
  return (
    isLocalHookConnectionId(row.connectionId ?? null) &&
    (!row.worktreeId || row.worktreeId === worktreeId)
  )
}

/**
 * The resume record a pane's own hook rows imply when no record was saved: a host whose daemon
 * restarted under it (only layout-owner builds record hook status), or an agent typed into a
 * shell. The execution host's hook store owns agent status, so it names the conversation.
 */
export function hookRowPaneResumeRecord(args: {
  rows: readonly AgentStatusIpcPayload[]
  worktreeId: string
  tab: ResumeRecordTab | undefined
}): SleepingAgentSessionRecord | null {
  const { worktreeId, tab } = args
  const row = args.rows
    .filter((candidate) => candidate.providerSession && isPaneLocalHookRow(candidate, worktreeId))
    .reduce<AgentStatusIpcPayload | null>(
      (latest, candidate) =>
        !latest || candidate.receivedAt > latest.receivedAt ? candidate : latest,
      null
    )
  if (!row || !tab) {
    return null
  }
  // An exited agent leaves only its resume identity, which is what a restore resumes.
  const status = resumeStatusFromHookRow({ ...row, providerSessionOnly: false }, undefined)
  if (!status?.providerSession) {
    return null
  }
  return liveResumeRecord({
    entry: status,
    retainsResumableIdentity: statusRetainsResumableIdentity(status, status.providerSession),
    worktreeIdOf: () => worktreeId,
    tabOf: () => tab,
    capturedAt: status.updatedAt
  })
}
