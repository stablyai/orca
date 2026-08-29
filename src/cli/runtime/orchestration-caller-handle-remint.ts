import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'

export function refreshOrchestrationCallerHandleAfterPaneRemint(
  envelope: RuntimeOrchestrationEnvelope,
  previousHandle: string,
  paneKey: string,
  remintedHandle: string
): RuntimeOrchestrationEnvelope {
  const evidence = envelope.orchestrationCompatibilityEvidence
  if (
    !evidence ||
    evidence.terminalHandle !== previousHandle ||
    evidence.paneKey !== paneKey ||
    !remintedHandle
  ) {
    return envelope
  }
  return {
    ...envelope,
    orchestrationCompatibilityEvidence: { ...evidence, terminalHandle: remintedHandle }
  }
}
