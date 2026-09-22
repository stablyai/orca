// Orca appends marker-delimited blocks to user-owned TOML config files. Two
// independent things can make a byte Orca's: it sits between a matched start and
// end marker, or the provider positively recognizes it as content Orca emitted.
// The end marker is the only proof of a block's extent, so once a hand-edit
// deletes it the rest of the file is unknown text — #18861: assuming otherwise
// deleted user tables through EOF. An orphaned block therefore owns nothing but
// its own stray marker line, and anything Orca actually wrote is reclaimed by
// recognition instead, wherever in the file it ended up.

export type ManagedTomlMarkers = {
  startMarker: string
  endMarker: string
}

export type ManagedTomlRegion = {
  /** First removable offset — includes the blank-line run above the content. */
  startOffset: number
  /** Offset one past the last owned line, terminator included. */
  endOffset: number
}

export type ManagedTomlBlockRegion = ManagedTomlRegion & {
  /** Offset of the start-marker line itself. */
  markerOffset: number
  /** End marker found: everything between the markers is Orca's. */
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
}

// Keeps offsets on the raw text so CRLF terminators are spliced back verbatim.
function scanLines(text: string): ScannedLine[] {
  const lines: ScannedLine[] = []
  let offset = 0
  while (offset < text.length) {
    const newlineIndex = text.indexOf('\n', offset)
    const endOffset = newlineIndex === -1 ? text.length : newlineIndex + 1
    lines.push({
      text: text.slice(offset, endOffset).replace(/\r?\n$/, ''),
      offset,
      endOffset
    })
    offset = endOffset
  }
  return lines
}

// Absorb the blank run above so install/remove cycles do not accumulate
// whitespace; overlapping runs are merged away by stripManagedTomlRegions.
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
  // Exact, not startsWith: a user quoting a marker in a comment of their own
  // ("# >>> ... >>> (example from the docs)") would otherwise open or close a
  // region and take every byte between the two quoted lines. Both emitters
  // write the marker as its own line, so nothing legitimate carries a suffix.
  const isStart = (index: number): boolean => lines[index].text.trim() === markers.startMarker
  const isEnd = (index: number): boolean => lines[index].text.trim() === markers.endMarker

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
    // Not terminated: `last` stays on the marker line, so the orphan owns only
    // the stray marker. Its body, if Orca wrote it, is reclaimed by recognition.
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

/**
 * Every table the provider recognizes as its own, anywhere in the file. Marker
 * position is irrelevant: content Orca emitted is Orca's to remove even when a
 * hand-edit stranded it outside the block (#18861).
 */
export function findRecognizedManagedTables<T>(
  text: string,
  recognize: ManagedTableRecognizer<T>
): RecognizedManagedTable<T>[] {
  const lines = scanLines(text)
  const texts = lines.map((line) => line.text)
  const tables: RecognizedManagedTable<T>[] = []
  for (let index = 0; index < lines.length; index++) {
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
