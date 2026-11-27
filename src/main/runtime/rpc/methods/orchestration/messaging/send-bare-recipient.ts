import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { withDispatchPrefixHint } from './dispatch-prefix-hint'
import { resolveBareOrchestrationRecipient, type SendRecipientWarning } from './recipient-routing'
import { prepareSessionRecipient } from './session-recipient'

/** Resolve a bare send recipient (terminal handle or session ID) and enforce peer Run ownership. */
export async function resolveBareSendRecipient(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  to: string
  rawTo: string | undefined
  senderRunId: string | undefined
  explicitRunId: string | undefined
  orchestrationCaller: OrchestrationEntryCaller | undefined
  revalidateLegacyCoordinator: (() => void) | undefined
}): Promise<{ to: string; runId: string | undefined; warning?: SendRecipientWarning }> {
  const { runtime, db, to, rawTo, senderRunId, explicitRunId, orchestrationCaller } = args
  const terminal = await prepareSessionRecipient(runtime, to, args.revalidateLegacyCoordinator)
  const recipient = resolveBareOrchestrationRecipient({
    runtime,
    db,
    handle: to,
    senderRunId,
    explicitRunId,
    terminalRecipient: terminal
  })
  if (!recipient.ok) {
    throw new OrchestrationError(recipient.code, withDispatchPrefixHint(db, to, recipient))
  }
  // A paired Orca's former worker may since have taken up local work; it is no longer its to reach.
  if (
    orchestrationCaller?.kind === 'peer' &&
    recipient.runId !== orchestrationCaller.peerRun.run_id
  ) {
    throw new OrchestrationError(
      'forbidden',
      `${rawTo} now works outside the Run ${orchestrationCaller.peerRun.home_label} coordinates here. No effects were applied.`,
      { effectsApplied: false }
    )
  }
  return {
    to: recipient.to,
    runId: recipient.runId,
    ...(recipient.warning ? { warning: recipient.warning } : {})
  }
}
