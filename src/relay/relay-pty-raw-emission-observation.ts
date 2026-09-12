import {
  advanceRelayPtyRawEmissionCheckpoint,
  type RelayPtyRawEmissionSlice
} from './relay-pty-raw-emission-checkpoint'
import type {
  RelayPtyOwnershipTransferRecord,
  RelayPtyOwnershipTransferOutputHistory
} from './relay-pty-ownership-transfer-adapter-state'

export function prepareRelayPtyRawEmissionObservation(
  transfer: RelayPtyOwnershipTransferRecord,
  slice: RelayPtyRawEmissionSlice | undefined,
  data: string,
  firstSeq: number,
  throughSeq: number
) {
  if (
    !transfer.destinationDelegation ||
    transfer.phase !== 'prepared' ||
    !transfer.destinationOutputRetention
  ) {
    return transfer.rawEmissionCheckpoint
  }
  if (!slice) {
    return undefined
  }
  if (
    slice.emissionId !== `${slice.rawStartSu}:${slice.rawEndSu}` ||
    slice.displayEndSu - slice.displayStartSu !== data.length
  ) {
    throw new Error('pty_raw_emission_observation_invalid')
  }
  return advanceRelayPtyRawEmissionCheckpoint(
    transfer.rawEmissionCheckpoint,
    slice,
    firstSeq,
    throughSeq
  )
}

export function isRelayPtyRawEmissionRetry(
  transfer: RelayPtyOwnershipTransferRecord,
  history: RelayPtyOwnershipTransferOutputHistory,
  slice: RelayPtyRawEmissionSlice | undefined,
  data: string
): boolean {
  const last = transfer.rawEmissionCheckpoint?.lastObserved
  if (
    transfer.phase !== 'prepared' ||
    !slice ||
    !last ||
    slice.emissionId !== last.slice.emissionId ||
    slice.displayStartSu !== last.slice.displayStartSu
  ) {
    return false
  }
  const frames = history.frames.filter(
    (frame) => frame.seq >= last.journalFirstSeq && frame.seq <= last.journalThroughSeq
  )
  if (
    slice.rawStartSu !== last.slice.rawStartSu ||
    slice.rawEndSu !== last.slice.rawEndSu ||
    slice.displayEndSu !== last.slice.displayEndSu ||
    slice.displayLengthSu !== last.slice.displayLengthSu ||
    history.nextSeq - 1 !== last.journalThroughSeq ||
    frames.length !== last.journalThroughSeq - last.journalFirstSeq + 1 ||
    frames.some((frame, index) => frame.seq !== last.journalFirstSeq + index || frame.truncated) ||
    frames.map((frame) => frame.data).join('') !== data
  ) {
    throw new Error('pty_raw_emission_retry_changed')
  }
  return true
}
