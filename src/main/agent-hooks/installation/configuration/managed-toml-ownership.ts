// Own only complete marker-delimited blocks or provider-recognized content; orphan markers never own through EOF.

import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from '../../../codex/configuration/toml/config-toml-line-scan'

export type ManagedTomlMarkers = {
  startMarker: string
  endMarker: string
}

export type ManagedTomlRegion = {
  /** Includes preceding blank lines. */
  startOffset: number
  /** Exclusive offset, including the line terminator. */
  endOffset: number
}

export type ManagedTomlBlockRegion = ManagedTomlRegion & {
  markerOffset: number
  terminated: boolean
}

export type RecognizedManagedTable<T> = ManagedTomlRegion & { value: T }

/** Line count of the table starting at `index` plus what the reader needs, or null. */
export type ManagedTableRecognizer<T> = (
  lines: readonly string[],
  index: number
) => { lineCount: number; value: T } | null

type ScannedLine = {
  text: string
  offset: number
  endOffset: number
  structural: boolean
}

// Keeps offsets on the raw text so CRLF terminators are spliced back verbatim.
function scanLines(text: string): ScannedLine[] {
  const lines: ScannedLine[] = []
  let offset = 0
  let state = createTomlLineScanState()
  while (offset < text.length) {
    const newlineIndex = text.indexOf('\n', offset)
    const endOffset = newlineIndex === -1 ? text.length : newlineIndex + 1
    const line = text.slice(offset, endOffset).replace(/\r?\n$/, '')
    lines.push({
      text: line,
      offset,
      endOffset,
      structural: isTomlStructuralLine(state)
    })
    state = updateTomlLineScanState(state, line)
    offset = endOffset
  }
  return lines
}

// Absorb preceding blanks so install/remove cycles do not accumulate whitespace.
function startOffsetAbsorbingBlanksAbove(lines: readonly ScannedLine[], index: number): number {
  let startLine = index
  while (startLine > 0 && lines[startLine - 1].text.trim() === '') {
    startLine--
  }
  return lines[startLine].offset
}

export function findManagedTomlBlocks(
  text: string,
  markers: ManagedTomlMarkers
): ManagedTomlBlockRegion[] {
  const lines = scanLines(text)
  // Markers inside string/array values are user data, not managed comments.
  const isStart = (index: number): boolean =>
    lines[index].structural && lines[index].text.trim() === markers.startMarker
  const isEnd = (index: number): boolean =>
    lines[index].structural && lines[index].text.trim() === markers.endMarker

  const regions: ManagedTomlBlockRegion[] = []
  for (let index = 0; index < lines.length; index++) {
    if (!isStart(index)) {
      continue
    }
    let last = index
    let terminated = false
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      // A second start marker never belongs to the block already open.
      if (isStart(cursor)) {
        break
      }
      if (isEnd(cursor)) {
        last = cursor
        terminated = true
        break
      }
    }
    // Orphan markers own no body; reclaim emitted content separately by recognition.
    regions.push({
      startOffset: startOffsetAbsorbingBlanksAbove(lines, index),
      markerOffset: lines[index].offset,
      endOffset: lines[last].endOffset,
      terminated
    })
    index = last
  }
  return regions
}

/** Recognition reclaims emitted tables even when hand edits move them outside their marked block. */
export function findRecognizedManagedTables<T>(
  text: string,
  recognize: ManagedTableRecognizer<T>
): RecognizedManagedTable<T>[] {
  const lines = scanLines(text)
  const texts = lines.map((line) => line.text)
  const tables: RecognizedManagedTable<T>[] = []
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].structural) {
      continue
    }
    const match = recognize(texts, index)
    if (!match || match.lineCount <= 0) {
      continue
    }
    const last = Math.min(index + match.lineCount, lines.length) - 1
    tables.push({
      startOffset: startOffsetAbsorbingBlanksAbove(lines, index),
      endOffset: lines[last].endOffset,
      value: match.value
    })
    index = last
  }
  return tables
}

/** Splices every owned region out in one pass, merging overlaps and nesting. */
export function stripManagedTomlRegions(
  text: string,
  regions: readonly ManagedTomlRegion[]
): { text: string; changed: boolean } {
  if (regions.length === 0) {
    return { text, changed: false }
  }
  const ordered = [...regions].sort((a, b) => a.startOffset - b.startOffset)
  let stripped = ''
  let cursor = 0
  for (const region of ordered) {
    if (region.endOffset <= cursor) {
      continue
    }
    stripped += text.slice(cursor, Math.max(cursor, region.startOffset))
    cursor = region.endOffset
  }
  stripped += text.slice(cursor)
  return { text: stripped, changed: stripped !== text }
}
