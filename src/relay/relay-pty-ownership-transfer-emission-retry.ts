import type { PtyOwnershipTransferOutputFragment } from '../shared/pty-ownership-transfer-output-envelope'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import {
  RELAY_PTY_OWNERSHIP_TRANSFER_RETRY_MEMO_MAX,
  type RelayPtyOwnershipTransferEmissionMemo,
  type RelayPtyOwnershipTransferRecord,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'

/** Replays a memoized emission without allocating new source sequences. */
export function retryObservedRelayPtyOwnershipTransferEmission(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: RelayPtyOwnershipTransferRecord,
  emissionKey: string,
  data: string
): readonly PtyOwnershipTransferOutputFragment[] | undefined {
  const previous = transfer.observedEmissions.get(emissionKey)
  if (!previous) {
    return undefined
  }
  if (previous.data !== data) {
    throw new RelayPtyOwnershipTransferError(
      'identity-mismatch',
      'ownership transfer emission key was reused with different output'
    )
  }
  const attachmentId = transfer.attachmentId
  if (!attachmentId) {
    throw new RelayPtyOwnershipTransferError(
      'stale-attachment',
      'post-commit output has no destination attachment'
    )
  }
  touchObservedEmission(transfer, emissionKey, previous)
  for (const frame of previous.frames) {
    state.options.publishDestinationOutput(transfer.identity, attachmentId, frame)
  }
  return previous.fragments
}

/** Remember a source emission until its sink has settled, within a bounded retry window. */
export function rememberRelayPtyOwnershipTransferEmission(
  transfer: RelayPtyOwnershipTransferRecord,
  memo: RelayPtyOwnershipTransferEmissionMemo
): void {
  touchObservedEmission(transfer, memo.key, memo)
  while (transfer.observedEmissions.size > RELAY_PTY_OWNERSHIP_TRANSFER_RETRY_MEMO_MAX) {
    const oldestKey = transfer.observedEmissions.keys().next().value
    if (typeof oldestKey !== 'string') {
      return
    }
    transfer.observedEmissions.delete(oldestKey)
  }
}

function touchObservedEmission(
  transfer: RelayPtyOwnershipTransferRecord,
  key: string,
  memo: RelayPtyOwnershipTransferEmissionMemo
): void {
  transfer.observedEmissions.delete(key)
  transfer.observedEmissions.set(key, memo)
}

export function forgetRelayPtyOwnershipTransferEmission(
  transfer: RelayPtyOwnershipTransferRecord,
  key: string
): void {
  transfer.observedEmissions.delete(key)
}
