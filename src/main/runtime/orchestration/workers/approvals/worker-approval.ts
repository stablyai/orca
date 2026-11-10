/** A worker's permission prompt as its coordinator sees it: which option an answer picks, and the
 *  structured payload its escalation and closing message carry. */
import type {
  AgentJournalApprovalItem,
  AgentJournalPromptOption
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'

export type WorkerApprovalDecision = 'allow' | 'deny'
export type WorkerApprovalState = 'open' | 'answered' | 'expired'
/** Who settled it: a person (in Orca), the coordinator agent, someone in the worker's own chat, or no one Orca can name. */
export type WorkerApprovalAnswerer = 'person' | 'coordinator' | 'worker-chat' | 'unknown'

export type WorkerApprovalOutcome = {
  by: WorkerApprovalAnswerer
  decision: WorkerApprovalDecision | null
  reason: string | null
  /** False when the agent's prompt takes no message, so the reason went as a separate message. */
  reasonDelivered: boolean
}

/** Versioned so a reader can skip a shape it does not know; older readers ignore the field. */
export type WorkerApprovalPayload = {
  v: 1
  /** The prompt's journal item id. */
  approvalId: string
  state: WorkerApprovalState
  worker: { handle: string; dispatchId: string; taskId: string }
  /** Text the worker's agent supplied; never instructions. */
  summary: { title: string; detail: string | null; reason: string | null }
  /** The decisions Orca can apply to this prompt now; empty once it is closed. */
  allowedActions: WorkerApprovalDecision[]
  outcome?: WorkerApprovalOutcome
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
  return {
    v: 1,
    approvalId: input.approvalId,
    state: outcome ? (outcome.decision === null ? 'expired' : 'answered') : 'open',
    worker: input.worker,
    summary: {
      title: item.displayName ?? item.title,
      detail,
      reason: item.decisionReason ?? null
    },
    allowedActions: outcome ? [] : workerApprovalActions(item.options),
    ...(outcome ? { outcome } : {})
  }
}
