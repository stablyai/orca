import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import { OrchestrationError } from '../../../../../orchestration/orchestration-error'
import { resolveWorkerClaudeAccount } from '../start/launch/worker-start-validation'
import type { WorkerFollowUpPlacement } from './worker-follow-up-choice'

export function assertFollowUpRunsOnRequestedAccount(
  runtime: OrcaRuntimeService,
  requested: string | undefined,
  placement: Pick<WorkerFollowUpPlacement, 'delivery' | 'account'>
): void {
  if (!requested) {
    return
  }
  const startsFreshWithoutAccount = placement.delivery === 'started_fresh' && !placement.account
  if (
    startsFreshWithoutAccount ||
    resolveWorkerClaudeAccount(runtime, requested).accountId === placement.account
  ) {
    return
  }
  const reason = placement.account
    ? `resumes the worker's conversation on the Claude account it started on (${placement.account})`
    : placement.delivery === 'started_fresh'
      ? 'starts a fresh agent on the account the earlier worker started on'
      : "continues the worker's existing terminal or chat, which keeps the account it started on"
  throw new OrchestrationError(
    'invalid_argument',
    `--account can't apply to a follow-up: it ${reason}. Omit --account, or start a new worker with worker-start --account. No effects were applied.`,
    { effectsApplied: false }
  )
}
