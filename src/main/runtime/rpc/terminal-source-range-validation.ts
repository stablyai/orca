import {
  assertTerminalOutputSourceRange,
  sameTerminalOutputSourceIdentity,
  type TerminalOutputSourceRange
} from '../../../shared/terminal-output-source-range'

export type TerminalSourceRangeFrame = Readonly<{
  encodedStartByte: number
  encodedEndByte: number
  displayLength: number
  outputSeq?: number
  sourceRanges: readonly TerminalOutputSourceRange[]
}>

export function freezeTerminalOutputSourceRanges(
  ranges: readonly TerminalOutputSourceRange[]
): readonly TerminalOutputSourceRange[] {
  return Object.freeze(
    ranges.map((range) =>
      Object.freeze({
        ...range,
        transform: Object.freeze({ ...range.transform })
      })
    )
  )
}

export function validateTerminalSourceRangeFrame(
  displayLength: number,
  ranges: readonly TerminalOutputSourceRange[]
): boolean {
  if (!Number.isSafeInteger(displayLength) || displayLength < 0) {
    return false
  }
  if (ranges.length === 0) {
    return true
  }
  try {
    for (const range of ranges) {
      assertTerminalOutputSourceRange(range)
    }
  } catch {
    return false
  }
  const first = ranges[0]!
  let previous = first
  for (const range of ranges.slice(1)) {
    if (
      !sameTerminalOutputSourceIdentity(first, range) ||
      range.sourceStartSu !== previous.sourceEndSu ||
      range.displayStart !== previous.displayEnd
    ) {
      return false
    }
    previous = range
  }
  return previous.displayEnd - first.displayStart === displayLength
}

export function replaceTerminalSourceRangeFrames(
  frames: readonly TerminalSourceRangeFrame[],
  snapshotSeq: number
): Readonly<{
  frames: TerminalSourceRangeFrame[]
  mappingMode: 'mapped' | null
  boundRange: TerminalOutputSourceRange | null
  mappedSourceEndSu: number | null
  mappedDisplayEnd: number | null
}> {
  const replaced = frames.map((frame) =>
    typeof frame.outputSeq === 'number' && frame.outputSeq <= snapshotSeq
      ? Object.freeze({ ...frame, sourceRanges: Object.freeze([]) })
      : frame
  )
  const remainingRanges = replaced.flatMap((frame) => frame.sourceRanges)
  const last = remainingRanges.at(-1)
  return Object.freeze({
    frames: replaced,
    mappingMode: remainingRanges.length > 0 ? 'mapped' : null,
    boundRange: last ?? null,
    mappedSourceEndSu: last?.sourceEndSu ?? null,
    mappedDisplayEnd: last?.displayEnd ?? null
  })
}

export function canPlanTerminalSourceRangeReplacement(
  frames: readonly TerminalSourceRangeFrame[],
  snapshotSeq: number
): boolean {
  return (
    Number.isSafeInteger(snapshotSeq) &&
    snapshotSeq >= 0 &&
    frames.every(
      (frame) =>
        frame.sourceRanges.length === 0 ||
        (typeof frame.outputSeq === 'number' && frame.outputSeq <= snapshotSeq)
    )
  )
}
