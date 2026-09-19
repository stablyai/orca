import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  RELAY_PTY_DESTINATION_EXECUTION_NOTIFICATION,
  parsePtyOwnershipTransferExecutionNotification
} from '../../shared/pty-ownership-transfer-execution-notification'
import type { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import { createOrcadDelegatedOutputPump } from './orcad-delegated-output-drain'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import type { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import {
  parsePtyOwnershipTransferDestinationReplayRequest,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD
} from '../../shared/pty-ownership-transfer-destination-claim'
import {
  parsePtyOwnershipTransferDestinationOutput,
  parsePtyOwnershipTransferDestinationOutputAck,
  RELAY_PTY_DESTINATION_OUTPUT_NOTIFICATION
} from '../../shared/pty-ownership-transfer-destination-output-wire'

/** Install during local-relay initialization, before coalesced notification frames are delivered. */
export function installOrcadDelegatedOutputReceiver(options: {
  multiplexer: Pick<SshChannelMultiplexer, 'onNotificationByMethod' | 'request' | 'onDispose'>
  outbox: PtyOwnershipTransferDestinationOutputOutbox
  proof: unknown
  baseEndSeq: number
  isActive: () => boolean
  onError: (error: unknown) => void
  onAcknowledged?: () => void
  onDrained?: () => void
  onExecutionChanged?: (finalOutputSeq: number) => void
  destinationAdapter?: PtyOwnershipTransferDestinationAdapter
  prepareModelFrame?: Parameters<typeof createOrcadDelegatedOutputPump>[0]['prepareModelFrame']
}) {
  const proof = parsePtyOwnershipTransferDestinationReplayRequest(options.proof)
  options.outbox.open(proof, options.baseEndSeq)
  let disposed = false
  let inFlight = false
  let pendingAck = proof.afterSeq
  let acknowledged = proof.afterSeq
  const active = () => !disposed && options.isActive()
  const pump = options.destinationAdapter
    ? createOrcadDelegatedOutputPump({
        identity: proof,
        adapter: options.destinationAdapter,
        outbox: options.outbox,
        isActive: active,
        prepareModelFrame: options.prepareModelFrame,
        onError: options.onError,
        onDrained: options.onDrained
      })
    : undefined
  const flush = () => {
    if (!active() || inFlight || pendingAck <= acknowledged) {
      return
    }
    const throughSeq = pendingAck
    inFlight = true
    void options.multiplexer
      .request(PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD, { ...proof, afterSeq: throughSeq })
      .then(
        (value) => {
          inFlight = false
          if (!active()) {
            return
          }
          try {
            const result = parsePtyOwnershipTransferDestinationOutputAck(value)
            if (
              !samePtyOwnershipTransferIdentity(result, proof) ||
              result.acknowledgedThroughSeq !== throughSeq
            ) {
              throw new Error('pty_ownership_transfer_destination_output_ack_mismatch')
            }
            acknowledged = throughSeq
            options.onAcknowledged?.()
          } catch (error) {
            options.onError(error)
            return
          }
          flush()
        },
        (error) => {
          inFlight = false
          if (active()) {
            options.onError(error)
          }
        }
      )
  }
  const remove = options.multiplexer.onNotificationByMethod(
    RELAY_PTY_DESTINATION_OUTPUT_NOTIFICATION,
    (value) => {
      if (!active()) {
        return
      }
      try {
        const message = parsePtyOwnershipTransferDestinationOutput(value)
        if (
          !samePtyOwnershipTransferIdentity(message, proof) ||
          message.destinationClaim.generation !== proof.destinationClaim.generation ||
          message.destinationClaim.claimId !== proof.destinationClaim.claimId
        ) {
          return
        }
        options.outbox.enqueue(proof, message.frame)
        if (!active()) {
          return
        }
        pendingAck = Math.max(pendingAck, message.frame.seq)
        flush()
        pump?.wake()
      } catch (error) {
        options.onError(error)
      }
    }
  )
  let removeDispose = () => {}
  const removeExecution = options.onExecutionChanged
    ? options.multiplexer.onNotificationByMethod(
        RELAY_PTY_DESTINATION_EXECUTION_NOTIFICATION,
        (value) => {
          if (!active()) {
            return
          }
          try {
            const message = parsePtyOwnershipTransferExecutionNotification(value)
            if (
              samePtyOwnershipTransferIdentity(message, proof) &&
              message.destinationClaim.generation === proof.destinationClaim.generation &&
              message.destinationClaim.claimId === proof.destinationClaim.claimId
            ) {
              options.onExecutionChanged?.(message.finalOutputSeq)
            }
          } catch (error) {
            options.onError(error)
          }
        }
      )
    : () => {}
  let stopping: Promise<void> | undefined
  const dispose = () => {
    if (disposed) {
      return stopping
    }
    disposed = true
    stopping = pump?.dispose() ?? Promise.resolve()
    remove()
    removeExecution()
    removeDispose()
    return stopping
  }
  removeDispose = options.multiplexer.onDispose(dispose)
  pump?.wake()
  return {
    retryAcknowledgement: flush,
    retryOutput: () => pump?.wake(),
    dispose
  }
}
