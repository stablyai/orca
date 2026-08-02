// Tiny, dependency-free markdown model for PR comment bodies. We render GitHub
// markdown without a third-party RN markdown library (the previous dependency hung
// the JS thread when a comment list mounted). Scope is deliberately small — the
// common comment elements — and parsing is pure + total: anything it can't classify
// falls through as paragraph text, so it can never throw on unexpected input.

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string }

export type CellAlign = 'left' | 'center' | 'right'

export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  // `lang` carries the fence info string (e.g. 'mermaid'); empty when unspecified.
  | { kind: 'code'; text: string; lang: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'hr' }
  | { kind: 'paragraph'; text: string }
  // GitHub comments use <details><summary>…</summary>…</details> for collapsibles.
  | { kind: 'details'; summary: string; body: MarkdownBlock[] }
  // GFM pipe table. `align` is per-column, parallel to `headers`.
  | { kind: 'table'; headers: string[]; rows: string[][]; align: CellAlign[] }

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^```/
// Captures the fence info string (language) on the opening fence, e.g. ```mermaid.
const FENCE_OPEN = /^```\s*([^\s`]*)/
// A GFM table delimiter row: cells of dashes with optional leading/trailing colons.
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const QUOTE = /^>\s?(.*)$/
const HR = /^(?:---+|\*\*\*+|___+)\s*$/
const UNORDERED = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
// A top-level <details>…</details> or <blockquote>…</blockquote> region.
const HTML_BLOCK = /<(details|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/i
const SUMMARY = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i

// Removes residual HTML tags from rendered text so stray <b>/<kbd>/<sub> etc. don't
// show literally. Conservative: only matches `<tag ...>` / `</tag>` shapes, so a bare
// "a < b" in prose is left alone.
export function stripHtmlTags(text: string): string {
  return text.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g, '')
}

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  // Drop HTML comments and normalize <br> before block parsing.
  const cleaned = content.replace(/<!--[\s\S]*?-->/g, '').replace(/<br\s*\/?>/gi, '\n')
  return parseSegment(cleaned)
}

// Splits a segment at top-level <details>/<blockquote> regions (preserving order),
// emitting structured blocks for them and line-parsing the text in between. Recurses
// for nested details bodies. Non-greedy match keeps it total on unbalanced input.
function parseSegment(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let rest = text
  let m = HTML_BLOCK.exec(rest)
  while (m) {
    const before = rest.slice(0, m.index)
    if (before.trim().length > 0) {
      blocks.push(...parseLines(before))
    }
    if (m[1].toLowerCase() === 'details') {
      const sm = SUMMARY.exec(m[2])
      const summary = sm ? stripHtmlTags(sm[1]).trim() : 'Details'
      const body = m[2].replace(SUMMARY, '')
      blocks.push({ kind: 'details', summary: summary || 'Details', body: parseSegment(body) })
    } else {
      blocks.push({ kind: 'quote', text: stripHtmlTags(m[2]).trim() })
    }
    rest = rest.slice(m.index + m[0].length)
    m = HTML_BLOCK.exec(rest)
  }
  if (rest.trim().length > 0) {
    blocks.push(...parseLines(rest))
  }
  return blocks
}

function parseLines(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let paragraph: string[] = []
  let i = 0

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join('\n').trim() })
      paragraph = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    if (FENCE.test(line)) {
      flushParagraph()
      const lang = (FENCE_OPEN.exec(line)?.[1] ?? '').toLowerCase()
      const code: string[] = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i])
        i += 1
      }
      i += 1 // consume closing fence (or EOF)
      blocks.push({ kind: 'code', text: code.join('\n'), lang })
      continue
    }

    // GFM pipe table: a header row immediately followed by a delimiter row.
    // Requires the delimiter row so plain prose with a stray `|` isn't captured.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      flushParagraph()
      const headers = splitTableRow(line)
      const align = parseAlignRow(lines[i + 1])
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      blocks.push({ kind: 'table', headers, rows, align })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      i += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() })
      i += 1
      continue
    }

    if (HR.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'hr' })
      i += 1
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      flushParagraph()
      const quoted: string[] = []
      let q: RegExpExecArray | null = quote
      while (q) {
        quoted.push(q[1])
        i += 1
        q = i < lines.length ? QUOTE.exec(lines[i]) : null
      }
      blocks.push({ kind: 'quote', text: quoted.join('\n').trim() })
      continue
    }

    const ordered = ORDERED.test(line)
    if (ordered || UNORDERED.test(line)) {
      flushParagraph()
      const items: string[] = []
      let match = ordered ? ORDERED.exec(line) : UNORDERED.exec(line)
      while (match) {
        items.push(match[1].trim())
        i += 1
        if (i >= lines.length) {
          break
        }
        match = ordered ? ORDERED.exec(lines[i]) : UNORDERED.exec(lines[i])
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    paragraph.push(line)
    i += 1
  }
  flushParagraph()
  return blocks
}

// Splits a `| a | b |` table row into trimmed cells. Tolerates missing outer
// pipes and escaped `\|` inside cells. Total: never throws on odd input.
function splitTableRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1)
  }
  if (trimmed.endsWith('|')) {
    trimmed = trimmed.slice(0, -1)
  }
  for (let j = 0; j < trimmed.length; j += 1) {
    const ch = trimmed[j]
    if (ch === '\\' && trimmed[j + 1] === '|') {
      cell += '|'
      j += 1
      continue
    }
    if (ch === '|') {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += ch
  }
  cells.push(cell.trim())
  return cells
}

// Reads alignment from a delimiter row's colons: `:--` left, `:-:` center, `--:` right.
function parseAlignRow(line: string): CellAlign[] {
  return splitTableRow(line).map((spec) => {
    const left = spec.startsWith(':')
    const right = spec.endsWith(':')
    if (left && right) {
      return 'center'
    }
    if (right) {
      return 'right'
    }
    return 'left'
  })
}

// Inline emphasis/code/link tokenizer. Walks the string once, longest-match first,
// emitting plain-text runs between matches. Unbalanced markers stay literal text.
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)]+\))/

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  // Strip residual inline HTML tags (<b>, <kbd>, <sub>, …) so they don't render
  // literally; emphasis/code/links below are markdown, not HTML, so this is safe.
  let rest = stripHtmlTags(text)
  let guard = 0
  while (rest.length > 0 && guard < 5000) {
    guard += 1
    const m = INLINE.exec(rest)
    if (!m || m.index === undefined) {
      tokens.push({ kind: 'text', text: rest })
      break
    }
    if (m.index > 0) {
      tokens.push({ kind: 'text', text: rest.slice(0, m.index) })
    }
    const token = m[0]
    if (token.startsWith('`')) {
      tokens.push({ kind: 'code', text: token.slice(1, -1) })
    } else if (token.startsWith('**') || token.startsWith('__')) {
      tokens.push({ kind: 'bold', text: token.slice(2, -2) })
    } else if (token.startsWith('[')) {
      const close = token.indexOf('](')
      tokens.push({
        kind: 'link',
        text: token.slice(1, close),
        url: token.slice(close + 2, -1)
      })
    } else {
      tokens.push({ kind: 'italic', text: token.slice(1, -1) })
    }
    rest = rest.slice(m.index + token.length)
  }
  return tokens
}
