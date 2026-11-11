import { AgentSessionAcquisitionRootExitObservedError } from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'

export function isKillDeliveredExitReceipt(
  receipt: Error | undefined
): receipt is AgentSessionAcquisitionRootExitObservedError {
  return (
    receipt instanceof AgentSessionAcquisitionRootExitObservedError &&
    receipt.deathEvidenceKind === 'kill-delivered'
  )
}
