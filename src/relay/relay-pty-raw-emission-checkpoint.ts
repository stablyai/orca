export type RelayPtyRawEmissionSlice = Readonly<{
  emissionId: string
  rawStartSu: number
  rawEndSu: number
  displayStartSu: number
  displayEndSu: number
  displayLengthSu: number
}>

type ObservedSlice = Readonly<{
  slice: RelayPtyRawEmissionSlice
  journalFirstSeq: number
  journalThroughSeq: number
}>

export type RelayPtyRawEmissionCheckpoint = Readonly<{
  rawOriginSu: number
  rawEndSu: number
  journalThroughSeq: number
  pending?: RelayPtyRawEmissionSlice
  lastObserved: ObservedSlice
}>

function invalid(): never {
  throw new Error('pty_raw_emission_checkpoint_invalid')
}

function natural(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function sameEmission(a: RelayPtyRawEmissionSlice, b: RelayPtyRawEmissionSlice): boolean {
  return (
    a.emissionId === b.emissionId &&
    a.rawStartSu === b.rawStartSu &&
    a.rawEndSu === b.rawEndSu &&
    a.displayLengthSu === b.displayLengthSu
  )
}

/** Raw progress advances only after every display slice has a contiguous journal boundary. */
export function advanceRelayPtyRawEmissionCheckpoint(
  state: RelayPtyRawEmissionCheckpoint | undefined,
  slice: RelayPtyRawEmissionSlice,
  journalFirstSeq: number,
  journalThroughSeq: number
): RelayPtyRawEmissionCheckpoint {
  if (
    typeof slice.emissionId !== 'string' ||
    slice.emissionId.length === 0 ||
    slice.emissionId.length > 256 ||
    ![
      slice.rawStartSu,
      slice.rawEndSu,
      slice.displayStartSu,
      slice.displayEndSu,
      slice.displayLengthSu,
      journalFirstSeq,
      journalThroughSeq
    ].every(natural) ||
    slice.rawEndSu <= slice.rawStartSu ||
    slice.displayStartSu > slice.displayEndSu ||
    slice.displayEndSu > slice.displayLengthSu ||
    (slice.displayLengthSu > 0 && slice.displayStartSu === slice.displayEndSu) ||
    journalFirstSeq === 0 ||
    journalThroughSeq < journalFirstSeq - 1 ||
    (slice.displayEndSu === slice.displayStartSu
      ? journalThroughSeq !== journalFirstSeq - 1
      : journalThroughSeq < journalFirstSeq)
  ) {
    invalid()
  }
  const last = state?.lastObserved
  if (
    last &&
    sameEmission(last.slice, slice) &&
    last.slice.displayStartSu === slice.displayStartSu &&
    last.slice.displayEndSu === slice.displayEndSu &&
    last.journalFirstSeq === journalFirstSeq &&
    last.journalThroughSeq === journalThroughSeq
  ) {
    return state!
  }
  if (state?.pending) {
    if (
      !sameEmission(state.pending, slice) ||
      slice.displayStartSu !== state.pending.displayEndSu
    ) {
      invalid()
    }
  } else if (
    slice.displayStartSu !== 0 ||
    (state &&
      (slice.rawStartSu !== state.rawEndSu ||
        slice.emissionId === state.lastObserved.slice.emissionId))
  ) {
    invalid()
  }
  if (last && journalFirstSeq - 1 !== last.journalThroughSeq) {
    invalid()
  }
  const copiedSlice = Object.freeze({ ...slice })
  const complete = slice.displayEndSu === slice.displayLengthSu
  return Object.freeze({
    rawOriginSu: state?.rawOriginSu ?? slice.rawStartSu,
    rawEndSu: complete ? slice.rawEndSu : (state?.rawEndSu ?? slice.rawStartSu),
    journalThroughSeq: complete
      ? journalThroughSeq
      : (state?.journalThroughSeq ?? journalFirstSeq - 1),
    ...(!complete ? { pending: copiedSlice } : {}),
    lastObserved: Object.freeze({ slice: copiedSlice, journalFirstSeq, journalThroughSeq })
  })
}
