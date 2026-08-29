import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import type { PtySourceRecoveryCheckpoint } from '../shared/pty-source-recovery-contract'
import type { PtySourceReceivingActivation } from '../shared/pty-source-receiving-activation'

export type RelayPtySourceDeliveryRecord = {
  clientId: number
  clientTransportGeneration?: number // transport incarnation of clientId; see RequestContext
  identity: PtySourceDeliveryIdentity
  sourceActivation: PtySourceReceivingActivation
  displayEnd: number
  activating: boolean
  activationRecoveryRequest: PtySourceRecoveryCheckpoint | null
  sealed: boolean
  legacyExitAccepted: boolean
  sourceExitState: 'idle' | 'pending' | 'published'
  sending: boolean
  turnFrames: number
  turnSourceSu: number
  turnScheduled: boolean
  sendWaiters: Set<() => void>
  recoveryCheckpointSourceEndSu: number | null
  recoveryEndSu: number | null
  recoveryCompletionPending: boolean
  restoreRequired: boolean
  rotationPending: boolean
}

/**
 * Is a request the same client on the same transport that opened this delivery?
 *
 * Why not clientId alone: Dispatcher.setWrite() revives the primary client without changing its id,
 * so a reconnected client compared by id is indistinguishable from one that never left. activate()
 * then answers 'existing' and returns before it ever reads the recovery argument, which is why
 * checkpointed source recovery has never run on an SSH reconnect (see
 * docs/reference/ssh-reconnect-source-recovery.md). resetClient() already bumps the transport
 * generation on exactly that path, so it is the term that separates the two.
 *
 * Both sides undefined means the caller does not model transports — a harness, or any non-dispatcher
 * caller — so it keeps the id-only answer rather than rotating on every attach.
 */
export function sameClientTransport(
  record: { clientId: number; clientTransportGeneration?: number },
  context: { clientId: number; transportGeneration?: number }
): boolean {
  return (
    record.clientId === context.clientId &&
    record.clientTransportGeneration === context.transportGeneration
  )
}
