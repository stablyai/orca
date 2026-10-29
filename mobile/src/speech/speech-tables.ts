import type { TableReading } from '../storage/speech-preferences'

// A table's second line, e.g. `|---|:---:|`; the pipe keeps a `---` rule from passing for one.
const DELIMITER_ROW = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?[ \t]*$/

function isDelimiterRow(line: string): boolean {
  return line.includes('|') && DELIMITER_ROW.test(line)
}

// A row of a table written without the delimiter row, which some agents send.
function isPipeRow(line: string): boolean {
  return /^[ \t]*\|.*\|[ \t]*$/.test(line)
}

/** A row's cells, without the punctuation that would clash with the commas they are read with. */
function cells(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) {
    row = row.slice(1)
  }
  if (row.endsWith('|') && !row.endsWith('\\|')) {
    row = row.slice(0, -1)
  }
  return row.split(/(?<!\\)\|/).map((cell) =>
    cell
      .replace(/\\\|/g, '|')
      .trim()
      .replace(/[.,;:]+$/, '')
  )
}

function joined(row: readonly string[]): string {
  return row.filter((cell) => cell.length > 0).join(', ')
}

/** One line per row, so each is read as a sentence: "Day: Tuesday, Run: intervals". */
function spokenTable(
  headers: string[] | null,
  rows: string[][],
  mode: TableReading,
  cue: string
): string[] {
  if (mode === 'skip') {
    return [cue]
  }
  if (mode === 'values' || headers === null || rows.length === 0) {
    return [headers, ...rows].filter((row) => row !== null).map(joined)
  }
  return rows.map((row) =>
    joined(row.map((cell, at) => (cell && headers[at] ? `${headers[at]}: ${cell}` : cell)))
  )
}

/**
 * Markdown tables in `text` as plain lines, read as `mode` says; the rest of toSpeechText then
 * cleans them up.
 */
export function speakableTables(text: string, mode: TableReading, cue: string): string {
  const lines = text.split('\n')
  const spoken: string[] = []
  let at = 0
  while (at < lines.length) {
    const withHeader = lines[at].includes('|') && isDelimiterRow(lines[at + 1] ?? '')
    if (!withHeader && !isPipeRow(lines[at])) {
      spoken.push(lines[at])
      at += 1
      continue
    }
    const headers = withHeader ? cells(lines[at]) : null
    at += withHeader ? 2 : 0
    const rows: string[][] = []
    while (at < lines.length && (withHeader ? lines[at].includes('|') : isPipeRow(lines[at]))) {
      if (!isDelimiterRow(lines[at])) {
        rows.push(cells(lines[at]))
      }
      at += 1
    }
    spoken.push(...spokenTable(headers, rows, mode, cue))
  }
  return spoken.join('\n')
}
