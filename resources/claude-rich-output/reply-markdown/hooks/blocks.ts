export const SWITCHES = [
  'headings',
  'lists',
  'quotes',
  'callouts',
  'tables',
  'rules',
  'codeCards'
] as const
export type Switch = (typeof SWITCHES)[number]

export type Block = { hasGapAbove: boolean } & (
  | { kind: 'raw'; text: string }
  | { kind: 'code'; language: string; source: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'item'; depth: number; marker: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; header: string[]; align: Align[]; rows: string[][]; source: string }
)
type Align = 'flex-start' | 'center' | 'flex-end'

export const FENCE = /^\s*(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})/
// The fences the reply-media mod draws as pictures: left as text, so that it
// gets them whichever of the two mods sits above the other. It reads fences of
// three backticks only; a `~~~` or longer one is code here.
const PICTURED = /^(mermaid|math)$/
// A `$$` formula's first and last line, as the reply-media mod reads them: the
// lines between are kept as text too, though one may look like a list item.
export const FORMULA = /^\$\$[ \t]*$/

export function closesFormula(lines: readonly string[], index: number) {
  for (let next = index + 1; next < lines.length; next++) {
    const line = lines[next] ?? ''
    if (FENCE.test(line)) {
      return false
    }
    if (FORMULA.test(line)) {
      return true
    }
  }
  return false
}

const RULE = /^ {0,3}([-*_])( *\1){2,} *$/
const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/
// A table's second line: `| --- | :-: |`, its colons the columns' alignment.
const DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
// A column narrower than this is not worth a table: the engine draws it.
const MIN_COLUMN = 6
// ponytail: what takes two columns is told by range (CJK, Hangul, full-width
// forms, emoji), not by the Unicode width tables; a cell measured short only
// wraps a line early. Use a width library if tables come out ragged.
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u

// ponytail: every unescaped `|` ends a cell, one inside a code span too.
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'))

/** A cell's text as it reads once drawn: its links and inline marks gone. */
export const plain = (cell: string) =>
  cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|~~|`/g, '')

const width = (text: string) => [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0)

/**
 * Each column's width: that of its widest cell, the widest columns narrowed
 * until the table is `room` columns wide; undefined when it cannot be.
 */
export function fit(table: { header: string[]; rows: string[][] }, room: number) {
  const widths = table.header.map((_, column) =>
    Math.max(1, ...[table.header, ...table.rows].map((row) => width(plain(row[column] ?? ''))))
  )
  // Each column has a bar and a space either side of its text; one bar ends the row.
  const available = room - (3 * widths.length + 1)

  while (widths.reduce((sum, each) => sum + each, 0) > available) {
    const widest = Math.max(...widths)
    if (widest <= MIN_COLUMN) {
      return undefined
    }
    widths[widths.indexOf(widest)] = widest - 1
  }

  return widths
}

// ponytail: a line-based split, not a markdown parser. Only headings, list
// items, quotes, rules, tables and closed code fences become blocks of the
// mod's; paragraphs stay raw text the engine draws. A quote ends at its last `>`
// line. Use a real parser if that leaks.
export function parse(text: string): Block[] {
  const blocks: Block[] = []
  let raw: string[] = []
  let hasGapAboveRaw = false
  let fence: string | undefined
  let wasBlank = false

  const flush = () => {
    const body = raw.join('\n').replace(/^\n+|\s+$/g, '')
    if (body !== '') {
      blocks.push({ kind: 'raw', text: body, hasGapAbove: hasGapAboveRaw })
    }
    raw = []
  }
  const keep = (line: string) => {
    if (raw.length === 0) {
      hasGapAboveRaw = wasBlank
    }
    raw.push(line)
  }

  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const below = lines[index + 1] ?? ''
    const isBlank = line.trim() === ''
    const heading = HEADING.exec(line)
    const item = ITEM.exec(line)
    const quote = QUOTE.exec(line)
    const last = blocks.at(-1)
    const opensFormula = fence === undefined && FORMULA.test(line) && closesFormula(lines, index)

    if (fence !== undefined) {
      keep(line)
      // Closed by a run of the same character at least as long, alone on its line.
      const run = FENCE.exec(line)?.[1] ?? (FORMULA.test(line) ? '$$' : '')
      const isClose = run[0] === fence[0] && run.length >= fence.length && line.trim() === run
      if (isClose) {
        const [open = '', ...body] = raw.slice(0, -1)
        const language = open.trim().slice(fence.length).trim().split(/\s+/)[0] ?? ''
        if (fence !== '$$' && !(fence === '```' && PICTURED.test(language))) {
          // A fence still open when the text ends (a reply mid-stream) stays
          // raw: `raw` holds it from its opening line on.
          const indent = open.length - open.trimStart().length
          blocks.push({
            kind: 'code',
            language,
            source: body
              .map((each) => each.replace(new RegExp(`^\\s{0,${indent}}`), ''))
              .join('\n'),
            hasGapAbove: hasGapAboveRaw
          })
          raw = []
        } else {
          flush()
        }
        fence = undefined
      }
    } else if (FENCE.test(line) || opensFormula) {
      flush()
      keep(line)
      fence = FENCE.exec(line)?.[1] ?? '$$'
    } else if (
      line.includes('|') &&
      DELIMITER.test(below) &&
      cells(line).length > 1 &&
      cells(line).length === cells(below).length
    ) {
      flush()
      const header = cells(line)
      const align = cells(below).map((mark): Align =>
        !mark.endsWith(':') ? 'flex-start' : mark.startsWith(':') ? 'center' : 'flex-end'
      )
      let end = index + 2
      while ((lines[end] ?? '').includes('|')) {
        end++
      }
      const rows = lines
        .slice(index + 2, end)
        .map((row) => header.map((_, column) => cells(row)[column] ?? ''))
      const source = lines.slice(index, end).join('\n')
      blocks.push({ kind: 'table', header, align, rows, source, hasGapAbove: wasBlank })
      index = end - 1
    } else if (quote && last?.kind === 'quote' && raw.length === 0 && !wasBlank) {
      last.text += `\n${quote[1] ?? ''}`
    } else if (quote) {
      flush()
      blocks.push({ kind: 'quote', text: quote[1] ?? '', hasGapAbove: wasBlank })
    } else if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule', hasGapAbove: wasBlank })
    } else if (heading) {
      flush()
      const [, hashes = '', title = ''] = heading
      blocks.push({ kind: 'heading', level: hashes.length, text: title, hasGapAbove: wasBlank })
    } else if (item) {
      flush()
      const [, indent = '', marker = '', body = ''] = item
      const depth = Math.min(6, Math.floor(indent.replaceAll('\t', '  ').length / 2))
      blocks.push({ kind: 'item', depth, marker, text: body, hasGapAbove: wasBlank })
    } else if (last?.kind === 'item' && raw.length === 0 && !wasBlank && /^\s+\S/.test(line)) {
      last.text += `\n${line.trim()}` // an item's wrapped line
    } else if (!isBlank || raw.length > 0) {
      keep(line)
    }

    wasBlank = isBlank
  }

  flush()

  return blocks
}
