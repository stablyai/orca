import type { BranchNameWorkContext } from '../../../shared/source-control/ai/naming/branch-name-from-work'
import type {
  BranchAutoRenameDeferredReason,
  BranchAutoRenameIneligibleReason,
  BranchAutoRenameOutcome
} from '../../../shared/worktree/branch-auto-rename-attempt'
import type { AgentGenerationFailureOutput } from '../../text-generation/failures/agent-failure-output'
import type { FirstWorkAttempt, FirstWorkRenameVerdict } from './first-work-rename-attempts'

/** What the generator names from: the event's prompt, or a click-time lookup. */
export type FirstWorkContextResolution =
  | { kind: 'context'; context: BranchNameWorkContext }
  | { kind: 'outcome'; outcome: BranchAutoRenameOutcome }
export type FirstWorkContextSource = () => Promise<FirstWorkContextResolution>

type RenameErrorSink = {
  setRenameError: (
    worktreeId: string,
    error: string | null,
    failureOutput?: AgentGenerationFailureOutput | null
  ) => void
}

export type FirstWorkVerdictBuilders = {
  stop: (
    reason: BranchAutoRenameIneligibleReason,
    log: string,
    clearError?: boolean
  ) => FirstWorkRenameVerdict
  defer: (reason: BranchAutoRenameDeferredReason, log: string) => FirstWorkRenameVerdict
  failed: (log: string, settles: boolean) => FirstWorkRenameVerdict
}

export function verdictBuilders(
  worktreeId: string,
  deps: RenameErrorSink
): FirstWorkVerdictBuilders {
  return {
    stop: (reason, log, clearError = false) => {
      if (clearError) {
        deps.setRenameError(worktreeId, null)
      }
      console.info(`[auto-branch-rename] skip (${log}) for ${worktreeId}`)
      return { outcome: { kind: 'ineligible', reason }, settles: true }
    },
    defer: (reason, log) => {
      console.info(`[auto-branch-rename] retry-later (${log}) for ${worktreeId}`)
      return { outcome: { kind: 'deferred', reason }, settles: false }
    },
    failed: (log, settles) => {
      console.info(`[auto-branch-rename] failed (${log}) for ${worktreeId}`)
      return { outcome: { kind: 'failed' }, settles }
    }
  }
}

/** Generation failures persist the error and back off; cancellation does neither. */
export function failedGenerationVerdict(
  worktreeId: string,
  generated: { error: string; canceled?: boolean; failureOutput?: AgentGenerationFailureOutput },
  deps: RenameErrorSink,
  verdicts: FirstWorkVerdictBuilders
): FirstWorkRenameVerdict {
  if (generated.canceled) {
    return verdicts.defer('interrupted', `generation canceled: ${generated.error}`)
  }
  deps.setRenameError(worktreeId, generated.error, generated.failureOutput ?? null)
  return {
    ...verdicts.failed(`generation failed: ${generated.error}`, false),
    generationFailed: true
  }
}

/** A lookup that settled after expiry, replacement or supersession must not start generation. */
export async function resolveFirstWorkContext(
  source: FirstWorkContextSource,
  attempt: FirstWorkAttempt
): Promise<FirstWorkContextResolution> {
  const resolved = await source()
  if (resolved.kind === 'context' && !attempt.isCurrent()) {
    attempt.assertIncarnation()
    return { kind: 'outcome', outcome: { kind: 'deferred', reason: 'history-unreadable' } }
  }
  return resolved
}
