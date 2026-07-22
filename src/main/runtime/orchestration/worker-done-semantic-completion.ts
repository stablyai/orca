/**
 * Fail-closed semantic completion for worker_done.
 *
 * Matching taskId + dispatchId is necessary but not sufficient: a payload that
 * declares failure, blocked/decision-required state, unresolved escalation, or
 * required remaining gates must not flip durable task/dispatch state to
 * completed. A durable task spec may explicitly authorize a code-complete /
 * activation-gate split; unmet activation/remaining gates still keep the
 * durable task blocked (the split authorizes code-complete mail, not
 * durable `completed`).
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
  /\b(failed\s+transactionally|migration(?:\s+\S+)?\s+failed|transaction(?:al)?(?:ly)?\s+failed|deploy(?:ment)?\s+failed|e2e\s+failed|(?:npm(?:\s+run)?\s+)?(?:lint|format:check|typecheck|test|build(?::cloudflare)?|smoke(?::cloudflare-worker-startup)?)\s+failed|required\s+(?:check|gate)s?\s+failed)\b/i
/** Past/transient failure wording that is narratively resolved — not a current terminal failure. */
const RESOLVED_FAILURE_NARRATIVE_RE =
  /\b(?:failed|failure)\b[\s\S]{0,160}\b(?:then\s+succeeded|succeeded\s+after(?:\s+(?:a\s+)?retry)?|after\s+(?:a\s+)?retr(?:y|ies)|later\s+succeeded|was\s+(?:then\s+)?(?:fixed|resolved)|retr(?:y|ied|ies)[\s\S]{0,60}succeed(?:ed|s)?)\b/i
const BLOCKED_SUBJECT_RE = /^\s*blocked\s*:/i
const BLOCKED_BODY_RE =
  /\b(blocked(?:\s+on|\s+by)?|status\s*[:=]\s*blocked|persist(?:ed|ing)?\s+blocked|leave(?:s|ing)?\s+(?:the\s+)?(?:task|pr)\s+blocked)\b/i
/** Past blocked wording that is narratively resolved — not a current blocked outcome. */
const RESOLVED_BLOCKED_NARRATIVE_RE =
  /\bblocked\b[\s\S]{0,100}\b(?:was\s+resolved|resolved|unblocked|cleared|lifted)\b/i
const DECISION_REQUIRED_RE =
  /\b(decision[- ]required|awaiting\s+(?:owner\s+)?decision|needs?\s+(?:a\s+)?(?:coordinator|owner)\s+decision|pending\s+decision\s+gate)\b/i
const UNRESOLVED_ESCALATION_RE =
  /\b(unresolved\s+escalation|escalation\s+(?:still\s+)?(?:open|unresolved|pending)|open\s+escalation)\b/i
const REMAINING_GATES_RE =
  /\b(remaining(?:\s+(?:required)?)?\s+(?:reconciliation|activation|owner[- ]gated|deploy(?:ment)?|migration)?\s*gates?|activation\s+gates?\s+remain(?:ing|s)?|reconciliation(?:\/activation)?\s+gates?\s+remain|what'?s\s+left\b.{0,80}\b(?:activation|reconciliation|migration|deploy|gate))/i
const PENDING_WORK_RE =
  /\b(activation\s+pending|waiting\s+for\s+owner(?:\s+approval)?|before\s+the\s+migration\s+can\s+run|owner\s+approval\s+before|not\s+yet\s+(?:migrated|deployed|activated)|still\s+need(?:s|ed)?\s+to\b|unfinished\s+required\s+(?:work|outcome))\b/i
const POSITIVE_COMPLETION_RE =
  /(?:^|[\s.,;:!?(])((?:is|are|was|were|has been|have been|mark(?:ed)?|now)\s+)?(complete(?:d)?|done|shipped|landed|merged|review-clean|implementation\s+finished)\b/i
const NEGATED_COMPLETION_RE =
  /\b(?:not|never|no(?:t)?\s+yet|hasn'?t|haven'?t|didn'?t|doesn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|cannot|can'?t)\b[\s\w-]{0,40}\b(?:complete(?:d)?|done|shipped|merged|landed)\b/i

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
  // filesModified proves activity only; never treat it as a completion claim.
  void input.filesModified

  const failedSubject = FAILURE_SUBJECT_RE.test(subject)
  const failedBody = FAILURE_BODY_RE.test(text)
  const resolvedFailureNarrative = RESOLVED_FAILURE_NARRATIVE_RE.test(text)
  if (failedSubject || (failedBody && !resolvedFailureNarrative)) {
    return {
      complete: false,
      kind: 'failure',
      appliedStatus: 'failed',
      reason:
        'worker_done declares failure and cannot be accepted as semantic completion'
    }
  }

  const blockedSubject = BLOCKED_SUBJECT_RE.test(subject)
  const blockedBody = BLOCKED_BODY_RE.test(text)
  const resolvedBlockedNarrative = RESOLVED_BLOCKED_NARRATIVE_RE.test(text)
  if (blockedSubject || (blockedBody && !resolvedBlockedNarrative)) {
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
    return {
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked',
      reason: splitAllowed
        ? 'worker_done reports unmet activation/remaining gates; durable task stays blocked despite an explicit code-complete/activation-gate split'
        : 'worker_done reports required remaining or pending work without an explicit durable code-complete/activation-gate split'
    }
  }

  const hasAffirmativeCompletionEvidence =
    !NEGATED_COMPLETION_RE.test(text) && POSITIVE_COMPLETION_RE.test(text)
  if (!hasAffirmativeCompletionEvidence) {
    return {
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked',
      reason:
        'worker_done lacks an explicit non-negated completion claim and cannot fail open on filesModified alone'
    }
  }

  return { complete: true }
}
