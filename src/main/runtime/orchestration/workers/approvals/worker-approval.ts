/** A worker's permission prompt as its coordinator sees it: which option an answer picks, and the
 *  structured payload its escalation and closing message carry. */
import type {
  AgentJournalApprovalItem,
  AgentJournalPromptOption
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'

import type {
  WorkerApprovalAnswerer,
  WorkerApprovalDecision,
  WorkerApprovalOutcome,
  WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'

export type {
  WorkerApprovalAnswerer,
  WorkerApprovalDecision,
  WorkerApprovalOutcome,
  WorkerApprovalPayload
}

/** The outcome of a chat prompt Orca answered: its reason is told only when it went to the worker as mail. */
export function chatAnswerOutcome(input: {
  by: WorkerApprovalAnswerer
  decision: WorkerApprovalDecision
  reason: string | null
  reasonMailed: boolean
}): WorkerApprovalOutcome {
  return {
    by: input.by,
    decision: input.decision,
    reason: input.reasonMailed ? input.reason : null,
    reasonDelivered: false
  }
}

const INTENT_OF: Record<WorkerApprovalDecision, AgentJournalPromptOption['intent']> = {
  allow: 'allow_once',
  deny: 'reject_once'
}

// Bounds the escalation, not the prompt: the full text stays in the worker's chat.
const SUMMARY_DETAIL_MAX_CHARS = 2_000

/** The one option a decision may pick: allow once or reject once. Never a standing rule, a stop,
 *  or a guess by position; none, or more than one, means Orca cannot answer it. */
export function workerApprovalOption(
  options: readonly AgentJournalPromptOption[],
  decision: WorkerApprovalDecision
): AgentJournalPromptOption | null {
  const matching = options.filter((option) => option.intent === INTENT_OF[decision])
  return matching.length === 1 ? matching[0] : null
}

export function workerApprovalActions(
  options: readonly AgentJournalPromptOption[]
): WorkerApprovalDecision[] {
  return (['allow', 'deny'] as const).filter((decision) =>
    Boolean(workerApprovalOption(options, decision))
  )
}

/** What the picked option meant, read back from a settled prompt. */
export function workerApprovalDecisionOf(
  item: AgentJournalApprovalItem
): WorkerApprovalDecision | null {
  const selected = item.options.find((option) => option.id === item.resolution.selectedOptionId)
  return selected?.intent === 'allow_once' || selected?.intent === 'allow_always'
    ? 'allow'
    : selected?.intent === 'reject_once' || selected?.intent === 'reject_always'
      ? 'deny'
      : null
}

export function workerApprovalPayload(input: {
  approvalId: string
  item: AgentJournalApprovalItem
  worker: WorkerApprovalPayload['worker']
  outcome?: WorkerApprovalOutcome
}): WorkerApprovalPayload {
  const { item, outcome } = input
  const detail =
    item.detail && item.detail.length > SUMMARY_DETAIL_MAX_CHARS
      ? `${item.detail.slice(0, SUMMARY_DETAIL_MAX_CHARS)}…`
      : item.detail
  const open: WorkerApprovalPayload = {
    v: 1,
    approvalId: input.approvalId,
    state: 'open',
    worker: input.worker,
    summary: {
      title: item.displayName ? `Allow ${item.displayName}?` : item.title,
      detail,
      reason: item.decisionReason ?? null
    },
    allowedActions: workerApprovalActions(item.options)
  }
  return outcome ? closedApproval(open, outcome) : open
}

/** The same approval once closed: nothing left to answer, and how it closed. */
export function closedApproval(
  open: WorkerApprovalPayload,
  outcome: WorkerApprovalOutcome
): WorkerApprovalPayload {
  const closed: WorkerApprovalPayload = {
    ...open,
    state: outcome.decision === null ? 'expired' : 'answered',
    allowedActions: [],
    outcome
  }
  // A countdown means nothing once the prompt is closed.
  delete closed.expiresAt
  return closed
}
