import type { AgentSessionExecutionView } from '../../../shared/agent-session-execution-view'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import {
  activeStructuredAgentSessionTurnId,
  hasUnansweredStructuredAgentSessionDispatch
} from '../../../shared/structured-agent-session-projection'

export function resolveStructuredAgentSessionExecution(input: {
  record: AgentSessionRecord
  nativeBound: boolean
  observation?: 'live' | 'unverifiable' | 'exited'
  currentItems: readonly AgentJournalRenderItem[]
  submissions: readonly AgentJournalSubmission[]
  backgroundWork: boolean
}): Pick<
  AgentSessionExecutionView,
  'observation' | 'activity' | 'control' | 'turnId' | 'promptIds' | 'recovery'
> {
  const { lease } = input.record
  const admitted = agentSessionLeaseAdmitsWriter(lease)
  const observation =
    input.observation === 'exited'
      ? 'exited'
      : input.nativeBound && admitted
        ? 'live'
        : lease.ownerProcess || lease.claimStatus === 'reserved' || lease.unreconciled
          ? (input.observation ?? 'unverifiable')
          : lease.deathEvidence
            ? 'exited'
            : 'none'
  const control =
    observation === 'live' && admitted
      ? input.nativeBound
        ? 'native'
        : lease.runtimeKind === 'tui'
          ? 'tui'
          : 'none'
      : 'none'
  const recovery = observation === 'unverifiable' || (observation === 'live' && control === 'none')
  const turnId =
    control === 'native' ? activeStructuredAgentSessionTurnId(input.currentItems) : null
  const promptIds =
    control === 'native'
      ? input.currentItems
          .filter(
            (item) =>
              (item.body.kind === 'approval' || item.body.kind === 'question') &&
              item.body.resolution.state === 'pending'
          )
          .map((item) => item.itemId)
      : []
  const pending =
    control === 'native' &&
    hasUnansweredStructuredAgentSessionDispatch(
      input.submissions.filter((submission) => submission.fence === lease.runtimeFence),
      lease.runtimeFence
    )
  // A live terminal owner is not an inventory of its current work.
  const activity =
    recovery || control === 'tui'
      ? 'unverifiable'
      : promptIds.length
        ? 'attention'
        : turnId || pending || (control === 'native' && input.backgroundWork)
          ? 'working'
          : 'idle'
  return { observation, activity, control, turnId, promptIds, recovery }
}
