import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { readRelayPtyOwnershipTransferJournalFrames } from './relay-pty-ownership-transfer-adapter-operations'

/** Display coverage only; raw delivery counters can differ after ingress transformations. */
export function readRelayPtyCaptureJournalSuffix(
  state: RelayPtyOwnershipTransferAdapterState,
  identity: PtyOwnershipTransferWireIdentity,
  afterSeq: number,
  expectedEndSeq: number
) {
  const replay = readRelayPtyOwnershipTransferJournalFrames(
    state,
    { version: 1, ...identity, afterSeq },
    'prepared'
  )
  if (
    afterSeq > replay.sourceOutputEndSeq ||
    replay.sourceOutputEndSeq !== expectedEndSeq ||
    replay.frames.length !== expectedEndSeq - afterSeq ||
    replay.frames.some((frame, index) => frame.seq !== afterSeq + index + 1)
  ) {
    throw new Error('pty_ownership_capture_selection_recovery_suffix_unavailable')
  }
  const displayUnits = replay.frames.reduce((total, frame) => total + frame.data.length, 0)
  if (!Number.isSafeInteger(displayUnits)) {
    throw new Error('pty_ownership_capture_selection_recovery_suffix_unavailable')
  }
  return Object.freeze({ throughSeq: expectedEndSeq, displayUnits })
}
