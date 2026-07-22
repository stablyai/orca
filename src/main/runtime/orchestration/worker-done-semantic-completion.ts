/**
 * Fail-closed semantic completion for worker_done.
 *
 * Matching taskId + dispatchId is necessary but not sufficient: a payload that
 * declares failure, blocked/decision-required state, unresolved escalation, or
 * required remaining gates must not flip durable task/dispatch state to
 * completed. A durable task spec may explicitly authorize a code-complete /
 * activation-gate split; only then may remaining activation/reconciliation
 * gates alone still complete.
 */

export type WorkerDoneIncompleteKind =
  | 'failure'
  | 'blocked'
  | 'decision_required'
  | 'unresolved_escalation'
  | 'remaining_gates'

export type WorkerDoneSemanticCompletion =
  | { complete: true }
  | {
      complete: false
      kind: WorkerDoneIncompleteKind
      reason: string
      appliedStatus: 'failed' | 'blocked'
    }

export interface WorkerDoneSemanticCompletionInput {
  subject: string
  body?: string | null
  filesModified?: readonly string[] | null
  taskSpec?: string | null
}

const FAILURE_SUBJECT_RE = /^\s*failed\s*:/i
const FAILURE_BODY_RE =
  /\b(failed\s+transactionally|migration\s+\S+\s+failed|transaction(?:al)?(?:ly)?\s+failed|deploy(?:ment)?\s+failed|e2e\s+failed)\b/i
const BLOCKED_SUBJECT_RE = /^\s*blocked\s*:/i
const BLOCKED_BODY_RE =
  /\b(blocked(?:\s+on|\s+by)?|status\s*[:=]\s*blocked|persist(?:ed|ing)?\s+blocked|leave(?:s|ing)?\s+(?:the\s+)?(?:task|pr)\s+blocked)\b/i
const DECISION_REQUIRED_RE =
  /\b(decision[- ]required|awaiting\s+(?:owner\s+)?decision|needs?\s+(?:a\s+)?(?:coordinator|owner)\s+decision|pending\s+decision\s+gate)\b/i
const UNRESOLVED_ESCALATION_RE =
  /\b(unresolved\s+escalation|escalation\s+(?:still\s+)?(?:open|unresolved|pending)|open\s+escalation)\b/i
const REMAINING_GATES_RE =
  /\b(remaining(?:\s+(?:required)?)?\s+(?:reconciliation|activation|owner[- ]gated|deploy(?:ment)?|migration)?\s*gates?|activation\s+gates?\s+remain(?:ing|s)?|reconciliation(?:\/activation)?\s+gates?\s+remain|what'?s\s+left\b.{0,80}\b(?:activation|reconciliation|migration|deploy|gate))/i
const PENDING_WORK_RE =
  /\b(activation\s+pending|waiting\s+for\s+owner(?:\s+approval)?|before\s+the\s+migration\s+can\s+run|owner\s+approval\s+before|not\s+yet\s+(?:migrated|deployed|activated)|still\s+need(?:s|ed)?\s+to\s+(?:migrate|deploy|activate)|unfinished\s+required\s+(?:work|outcome))\b/i
const POSITIVE_COMPLETION_RE =
  /\b(complete(?:d)?|done|shipped|landed|merged|review-clean|implementation\s+finished)\b/i

const CODE_COMPLETE_ACTIVATION_SPLIT_RE =
  /\b(code[- ]complete(?:\s+vs\.?|\s+versus|\s*\/\s*|\s+from\s+)?\s*activation|activation[- ]gate\s+split|explicit(?:ly)?\s+(?:defines?|allow(?:s|ed)?)\s+(?:a\s+)?(?:code[- ]complete|activation[- ]gate)\s+split|owner[- ]gated\s+activation(?:\s+dependency)?\s+(?:may|can|should)\s+remain|send\s+worker_done\s+when\s+(?:the\s+)?code(?:\/docs)?(?:\s+change)?\s+is\s+complete)\b/i

export function taskSpecDefinesCodeCompleteActivationSplit(taskSpec: string | null | undefined): boolean {
  return typeof taskSpec === 'string' && CODE_COMPLETE_ACTIVATION_SPLIT_RE.test(taskSpec)
}

export function evaluateWorkerDoneSemanticCompletion(
  input: WorkerDoneSemanticCompletionInput
): WorkerDoneSemanticCompletion {
  const subject = input.subject ?? ''
  const body = input.body ?? ''
  const text = `${subject}\n${body}`
  const splitAllowed = taskSpecDefinesCodeCompleteActivationSplit(input.taskSpec)
  const filesModified = Array.isArray(input.filesModified)
    ? input.filesModified.filter((file) => typeof file === 'string' && file.trim().length > 0)
    : []

  if (FAILURE_SUBJECT_RE.test(subject) || FAILURE_BODY_RE.test(text)) {
    return {
      complete: false,
      kind: 'failure',
      appliedStatus: 'failed',
      reason:
        'worker_done declares failure and cannot be accepted as semantic completion'
    }
  }

  if (BLOCKED_SUBJECT_RE.test(subject) || BLOCKED_BODY_RE.test(text)) {
    return {
      complete: false,
      kind: 'blocked',
      appliedStatus: 'blocked',
      reason:
        'worker_done declares a blocked state; use escalation/status and coordinator reclassification'
    }
  }

  if (DECISION_REQUIRED_RE.test(text)) {
    return {
      complete: false,
      kind: 'decision_required',
      appliedStatus: 'blocked',
      reason:
        'worker_done declares a decision-required state; resolve the gate or escalate instead of completing'
    }
  }

  if (UNRESOLVED_ESCALATION_RE.test(text)) {
    return {
      complete: false,
      kind: 'unresolved_escalation',
      appliedStatus: 'blocked',
      reason:
        'worker_done reports an unresolved escalation and cannot close durable completion'
    }
  }

  if (REMAINING_GATES_RE.test(text) || PENDING_WORK_RE.test(text)) {
    if (splitAllowed) {
      return { complete: true }
    }
    return {
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked',
      reason:
        'worker_done reports required remaining or pending work without an explicit durable code-complete/activation-gate split'
    }
  }

  const hasPositiveCompletionEvidence =
    POSITIVE_COMPLETION_RE.test(text) || filesModified.length > 0
  if (!hasPositiveCompletionEvidence) {
    return {
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked',
      reason:
        'worker_done lacks positive completion evidence (completion language or filesModified) and cannot fail open'
    }
  }

  return { complete: true }
}
