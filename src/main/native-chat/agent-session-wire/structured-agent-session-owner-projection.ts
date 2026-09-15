import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { cancelledJournalPromptBody } from '../agent-session-journal/journal-prompt-body-bounds'

function isStaleFence(record: AgentSessionRecord | null, fence: number | undefined): boolean {
  return (
    fence !== undefined &&
    (!record ||
      (fence <= record.lease.runtimeFence &&
        (record.lease.claimStatus !== 'live' || fence < record.lease.runtimeFence)))
  )
}

export function structuredAgentSessionNeedsOwnerSnapshot(
  snapshot: AgentJournalSnapshot,
  record: AgentSessionRecord | null
): boolean {
  return (
    snapshot.items.some((item) => {
      if (!isStaleFence(record, item.ownerFence)) {
        return false
      }
      const body = item.body
      return (
        readAgentJournalTurn(body)?.state === 'running' ||
        (body.kind === 'tool-call' && body.state === 'running') ||
        ((body.kind === 'approval' || body.kind === 'question') &&
          body.resolution.state === 'pending')
      )
    }) ||
    snapshot.submissions.some(
      (submission) =>
        isStaleFence(record, submission.fence) &&
        (submission.dispatchState === 'pending' ||
          (submission.dispatchState === 'unknown' && submission.recovered !== true))
    )
  )
}

/** The lease, not an unsettled journal write, decides what can still ask or work. */
export function projectStructuredAgentSessionOwnerPage(
  page: AgentSessionHistoryPage,
  record: AgentSessionRecord | null
): AgentSessionHistoryPage {
  const items = page.items.map((item): AgentJournalRenderItem => {
    if (!isStaleFence(record, item.ownerFence)) {
      return item
    }
    const body = item.body
    const turn = readAgentJournalTurn(body)
    if (turn?.state === 'running' && (body.kind === 'turn' || body.kind === 'status')) {
      const evidence = record?.lease.deathEvidence
      const retryFence = record?.lease.settlementRetryFence
      const witnessed =
        evidence?.kind === 'exit-observed' &&
        retryFence !== undefined &&
        (item.ownerFence === retryFence ||
          (record?.lease.claimStatus === 'released' &&
            record.lease.handoffStage === 'old-owner-stopped' &&
            item.ownerFence === retryFence + 1))
      const lifecycle = witnessed
        ? { ...turn, state: 'interrupted' as const, completedAt: evidence.observedAt }
        : { ...turn, state: 'unverifiable' as const }
      return {
        ...item,
        body:
          body.kind === 'turn'
            ? { kind: 'turn', ...lifecycle }
            : { ...body, turnLifecycle: lifecycle }
      }
    }
    if (body.kind === 'tool-call' && body.state === 'running') {
      return { ...item, body: { ...body, state: 'failed' } }
    }
    const cancelled = cancelledJournalPromptBody(body)
    return cancelled &&
      (body.kind === 'approval' || body.kind === 'question') &&
      body.resolution.state === 'pending'
      ? { ...item, body: cancelled }
      : item
  })
  const submissions = page.submissions.map((submission): AgentJournalSubmission =>
    isStaleFence(record, submission.fence) &&
    (submission.dispatchState === 'pending' ||
      (submission.dispatchState === 'unknown' && submission.recovered !== true))
      ? {
          ...submission,
          dispatchState: 'unknown',
          recovered: true,
          reason: 'provider_exited_before_acknowledgement'
        }
      : submission
  )
  return { ...page, items, submissions }
}
