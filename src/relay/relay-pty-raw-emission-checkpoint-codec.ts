import type {
  RelayPtyRawEmissionCheckpoint,
  RelayPtyRawEmissionSlice
} from './relay-pty-raw-emission-checkpoint'
import {
  invalidJournal,
  requireRecord,
  sequence,
  positiveSequence
} from './relay-pty-ownership-transfer-journal-record-validation'

function parseSlice(value: unknown): RelayPtyRawEmissionSlice {
  const record = requireRecord(value)
  const slice = {
    emissionId: record.emissionId,
    rawStartSu: sequence(record.rawStartSu),
    rawEndSu: sequence(record.rawEndSu),
    displayStartSu: sequence(record.displayStartSu),
    displayEndSu: sequence(record.displayEndSu),
    displayLengthSu: sequence(record.displayLengthSu)
  }
  if (
    slice.emissionId !== `${slice.rawStartSu}:${slice.rawEndSu}` ||
    slice.rawEndSu <= slice.rawStartSu ||
    slice.displayStartSu > slice.displayEndSu ||
    slice.displayEndSu > slice.displayLengthSu ||
    (slice.displayLengthSu > 0 && slice.displayStartSu === slice.displayEndSu)
  ) {
    throw invalidJournal()
  }
  return Object.freeze({ ...slice, emissionId: String(slice.emissionId) })
}

export function parseRelayPtyRawEmissionCheckpoint(
  value: unknown,
  sourceOutputEndSeq: number
): RelayPtyRawEmissionCheckpoint | undefined {
  if (value === undefined) {
    return undefined
  }
  const record = requireRecord(value)
  const rawOriginSu = sequence(record.rawOriginSu)
  const rawEndSu = sequence(record.rawEndSu)
  const journalThroughSeq = sequence(record.journalThroughSeq)
  const observed = requireRecord(record.lastObserved)
  const slice = parseSlice(observed.slice)
  const journalFirstSeq = positiveSequence(observed.journalFirstSeq)
  const observedThroughSeq = sequence(observed.journalThroughSeq)
  const pending = record.pending === undefined ? undefined : parseSlice(record.pending)
  if (
    rawOriginSu > rawEndSu ||
    rawOriginSu > slice.rawStartSu ||
    journalThroughSeq > observedThroughSeq ||
    observedThroughSeq > sequence(sourceOutputEndSeq) ||
    (slice.displayLengthSu === 0
      ? observedThroughSeq !== journalFirstSeq - 1
      : observedThroughSeq < journalFirstSeq)
  ) {
    throw invalidJournal()
  }
  if (pending) {
    if (
      JSON.stringify(pending) !== JSON.stringify(slice) ||
      slice.displayEndSu === slice.displayLengthSu ||
      rawEndSu !== slice.rawStartSu ||
      (slice.displayStartSu === 0
        ? journalThroughSeq !== journalFirstSeq - 1
        : journalThroughSeq >= journalFirstSeq - 1)
    ) {
      throw invalidJournal()
    }
  } else if (
    slice.displayEndSu !== slice.displayLengthSu ||
    rawEndSu !== slice.rawEndSu ||
    journalThroughSeq !== observedThroughSeq
  ) {
    throw invalidJournal()
  }
  return Object.freeze({
    rawOriginSu,
    rawEndSu,
    journalThroughSeq,
    ...(pending ? { pending } : {}),
    lastObserved: Object.freeze({ slice, journalFirstSeq, journalThroughSeq: observedThroughSeq })
  })
}
