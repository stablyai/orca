import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import type { MessageRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { assertCallerHandleMatchesEvidence, orchestrationCallerIdentity } from '../runs/run-scope'

/** The caller's Dispatch when a helper asked this question of it; the Run answers otherwise. */
export function helperQuestionAnswerer(
  runtime: OrcaRuntimeService,
  args: {
    question: MessageRow
    from: string | undefined
    session: OrchestrationSessionCaller | undefined
    evidence: OrchestrationCompatibilityEvidence | undefined
  }
): { dispatchId: string; consumerGeneration: number } | undefined {
  const askedOf = args.question.to_handle.startsWith('dispatch:')
    ? args.question.to_handle.slice('dispatch:'.length)
    : undefined
  if (!askedOf || (!args.from && !args.session)) {
    return undefined
  }
  const handle = args.from ?? ''
  if (args.from) {
    assertCallerHandleMatchesEvidence(runtime, args.from, args.evidence)
  }
  const caller = orchestrationCallerIdentity(runtime, {
    handle,
    session: args.session,
    paneKey: args.session ? undefined : runtime.getTerminalPaneKey(handle)
  })
  const own = runtime
    .getOrchestrationDb()
    .getActiveDispatchForIdentity(caller.address, caller.paneKey ?? undefined)
  return own?.id === askedOf
    ? { dispatchId: own.id, consumerGeneration: own.consumer_generation }
    : undefined
}
