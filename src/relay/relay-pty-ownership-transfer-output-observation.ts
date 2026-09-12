import type { PtyOwnershipTransferOutputFragment } from '../shared/pty-ownership-transfer-output-envelope'
import { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION } from '../shared/pty-ownership-transfer-wire'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import {
  forgetRelayPtyOwnershipTransferEmission,
  rememberRelayPtyOwnershipTransferEmission,
  retryObservedRelayPtyOwnershipTransferEmission
} from './relay-pty-ownership-transfer-emission-retry'
import {
  emptyRelayPtyOwnershipTransferHistory,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'
import { splitTransferOutputFrames } from './relay-pty-ownership-transfer-adapter-validation'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { matchesRelayPtyOwnershipTransferSourceIncarnation } from './relay-pty-ownership-transfer-source-incarnation'
import type { RelayPtyRawEmissionSlice } from './relay-pty-raw-emission-checkpoint'
import {
  prepareRelayPtyRawEmissionObservation,
  isRelayPtyRawEmissionRetry
} from './relay-pty-raw-emission-observation'

/** Capture source bytes and publish committed frames with durable sequence fencing. */
export function observeRelayPtyOwnershipTransferOutput(
  state: RelayPtyOwnershipTransferAdapterState,
  terminalId: string,
  data: string,
  emissionKey?: string,
  admittedIncarnationId?: string,
  ingressSlice?: RelayPtyRawEmissionSlice
): readonly PtyOwnershipTransferOutputFragment[] | undefined {
  if (!terminalId || (data.length === 0 && !ingressSlice)) {
    return undefined
  }
  const bridgeId = state.transferByTerminal.get(terminalId)
  const transfer = bridgeId ? state.transfers.get(bridgeId) : undefined
  // Only the host ingress queue can attest bytes admitted before physical exit.
  const admittedRetry =
    transfer &&
    !transfer.exit &&
    emissionKey &&
    admittedIncarnationId === transfer.identity.incarnationId
  if (
    transfer &&
    !admittedRetry &&
    !matchesRelayPtyOwnershipTransferSourceIncarnation(state, transfer)
  ) {
    return undefined
  }
  if (transfer && emissionKey) {
    const retried = retryObservedRelayPtyOwnershipTransferEmission(
      state,
      transfer,
      emissionKey,
      data
    )
    if (retried) {
      return retried
    }
  }
  const history = state.histories.get(terminalId) ?? emptyRelayPtyOwnershipTransferHistory()
  if (transfer && isRelayPtyRawEmissionRetry(transfer, history, ingressSlice, data)) {
    persistRelayPtyOwnershipTransfer(state, transfer)
    state.wakeDestinationOutput?.()
    return undefined
  }
  if (transfer?.destinationOutputRetention && transfer.phase !== 'aborted') {
    const unacknowledgedBytes = history.frames.reduce(
      (bytes, frame) =>
        bytes +
        (frame.seq > (transfer.destinationAcknowledgedSeq ?? 0)
          ? Buffer.byteLength(frame.data, 'utf8')
          : 0),
      0
    )
    if (unacknowledgedBytes + Buffer.byteLength(data, 'utf8') > state.replayBytes) {
      throw new Error('pty_ownership_transfer_destination_output_capacity')
    }
  }
  const previousHistory = transfer
    ? {
        nextSeq: history.nextSeq,
        retainedBytes: history.retainedBytes,
        frames: history.frames.slice()
      }
    : undefined
  const previousSourceOutputEndSeq = transfer?.sourceOutputEndSeq
  const previousReplayStartSeq = transfer?.replayStartSeq
  let nextSeq = history.nextSeq
  const frames = splitTransferOutputFrames(data, () => nextSeq++)
  const previousRawCheckpoint = transfer?.rawEmissionCheckpoint
  const rawCheckpoint = transfer
    ? prepareRelayPtyRawEmissionObservation(
        transfer,
        ingressSlice,
        data,
        history.nextSeq,
        nextSeq - 1
      )
    : undefined
  history.nextSeq = nextSeq
  for (const frame of frames) {
    history.frames.push(frame)
    history.retainedBytes += Buffer.byteLength(frame.data, 'utf8')
    while (history.retainedBytes > state.replayBytes && history.frames.length > 0) {
      const removed = history.frames.shift()!
      history.retainedBytes -= Buffer.byteLength(removed.data, 'utf8')
    }
  }
  state.histories.set(terminalId, history)
  if (!transfer) {
    return undefined
  }
  transfer.sourceOutputEndSeq = history.nextSeq - 1
  transfer.rawEmissionCheckpoint = rawCheckpoint
  transfer.replayStartSeq = history.frames[0]?.seq ?? history.nextSeq
  let fragments: PtyOwnershipTransferOutputFragment[] | undefined
  if (
    !transfer.destinationDelegation &&
    (transfer.phase === 'committed' || transfer.phase === 'published')
  ) {
    fragments = frames.map((frame) =>
      Object.freeze({
        data: frame.data,
        ownershipTransfer: Object.freeze({
          ...transfer.identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          frameSeq: frame.seq,
          fragmentStartSu: 0,
          fragmentEndSu: frame.data.length,
          frameLengthSu: frame.data.length
        })
      })
    )
    if (emissionKey) {
      rememberRelayPtyOwnershipTransferEmission(transfer, {
        key: emissionKey,
        data,
        frames,
        fragments
      })
    }
  }
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    if (emissionKey && fragments) {
      forgetRelayPtyOwnershipTransferEmission(transfer, emissionKey)
    }
    state.histories.set(terminalId, previousHistory!)
    transfer.sourceOutputEndSeq = previousSourceOutputEndSeq!
    transfer.replayStartSeq = previousReplayStartSeq!
    transfer.rawEmissionCheckpoint = previousRawCheckpoint
    throw error
  }
  if (
    transfer.phase === 'prepared' ||
    (transfer.destinationDelegation && transfer.phase === 'committed')
  ) {
    state.wakeDestinationOutput?.()
    return undefined
  }
  if (!fragments) {
    return undefined
  }
  const attachmentId = transfer.attachmentId
  if (!attachmentId) {
    throw new RelayPtyOwnershipTransferError(
      'stale-attachment',
      'post-commit output has no destination attachment'
    )
  }
  // Why: persist every sequence before fallible publication so retries cannot reuse it.
  for (const frame of frames) {
    state.options.publishDestinationOutput(transfer.identity, attachmentId, frame)
  }
  return Object.freeze(fragments)
}
