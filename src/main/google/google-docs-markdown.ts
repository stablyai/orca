// Markdown to Docs edits, for `orca docs append` (the Docs API takes no Markdown): headings, bullet
// and numbered lists, bold, italic, code and links. Tables and quotes go in as plain lines.

type Span = { start: number; end: number; bold?: true; italic?: true; code?: true; link?: string }
type Paragraph = { start: number; end: number; heading?: number; list?: 'bullet' | 'numbered' }

export type MarkdownText = { text: string; paragraphs: Paragraph[]; spans: Span[] }

const INLINE =
  /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*\s][^*]*?)\*|(?<![A-Za-z0-9])_([^_\s][^_]*?)_(?![A-Za-z0-9])/g

/** One line's inline marks: the text without them, and where each style goes. */
function inline(line: string, offset: number): { text: string; spans: Span[] } {
  let text = ''
  const spans: Span[] = []
  let last = 0
  for (const match of line.matchAll(INLINE)) {
    text += line.slice(last, match.index)
    const [, bold1, bold2, code, linkText, url, italic1, italic2] = match
    const inner = bold1 ?? bold2 ?? code ?? linkText ?? italic1 ?? italic2 ?? ''
    const start = offset + text.length
    text += inner
    const end = offset + text.length
    spans.push(
      bold1 !== undefined || bold2 !== undefined
        ? { start, end, bold: true }
        : code !== undefined
          ? { start, end, code: true }
          : url !== undefined
            ? { start, end, link: url }
            : { start, end, italic: true }
    )
    last = match.index + match[0].length
  }
  return { text: text + line.slice(last), spans }
}

export function markdownToDocText(markdown: string): MarkdownText {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const paragraphs: Paragraph[] = []
  const spans: Span[] = []
  const out: string[] = []
  let length = 0
  let inCode = false
  // A soft-wrapped line continues the paragraph above it.
  let open = false
  const push = (line: string, style: Omit<Paragraph, 'start' | 'end'> = {}, raw = false) => {
    const start = length + (out.length ? 1 : 0)
    const shown = raw ? { text: line, spans: [] } : inline(line, start)
    out.push(shown.text)
    length = start + shown.text.length
    paragraphs.push({ start, end: length, ...style })
    spans.push(...shown.spans)
    if (raw) {
      spans.push({ start, end: length, code: true })
    }
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode
      open = false
      continue
    }
    if (inCode) {
      push(line, {}, true)
      continue
    }
    const trimmed = line.trim()
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (
      !trimmed ||
      /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) ||
      /^\|?[\s:|-]+\|[\s:|-]*$/.test(trimmed)
    ) {
      open = false
    } else if (heading) {
      push(heading[2] ?? '', { heading: heading[1]?.length ?? 1 })
      open = false
    } else if (item) {
      // Nesting goes in as leading tabs, which Docs turns into list levels.
      const level = Math.floor((item[1] ?? '').replace(/\t/g, '  ').length / 2)
      push(`${'\t'.repeat(level)}${item[3] ?? ''}`, {
        list: /\d/.test(item[2] ?? '') ? 'numbered' : 'bullet'
      })
      open = false
    } else if (open && !trimmed.startsWith('|')) {
      const joined = inline(` ${trimmed.replace(/^>\s?/, '')}`, length)
      out[out.length - 1] += joined.text
      length += joined.text.length
      const paragraph = paragraphs.at(-1)
      if (paragraph) {
        paragraph.end = length
      }
      spans.push(...joined.spans)
    } else {
      push(trimmed.replace(/^>\s?/, ''))
      open = !trimmed.startsWith('|')
    }
  }
  return { text: out.join('\n'), paragraphs, spans }
}

/** The batchUpdate requests that insert `markdown` at `index`, styled, after an optional new line. */
export function appendRequests(markdown: string, index: number, newParagraph: boolean): unknown[] {
  const converted = markdownToDocText(markdown)
  const base = index + (newParagraph ? 1 : 0)
  const all = { startIndex: base, endIndex: base + converted.text.length }
  const range = (part: { start: number; end: number }) => ({
    startIndex: base + part.start,
    endIndex: base + Math.max(part.end, part.start + 1)
  })
  // Inserted text takes the style around it; clear that first, then apply the Markdown's own.
  const requests: unknown[] = [
    { insertText: { location: { index }, text: `${newParagraph ? '\n' : ''}${converted.text}` } },
    {
      updateParagraphStyle: {
        range: all,
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        fields: 'namedStyleType'
      }
    },
    { deleteParagraphBullets: { range: all } },
    {
      updateTextStyle: { range: all, textStyle: {}, fields: 'bold,italic,link,weightedFontFamily' }
    }
  ]
  for (const paragraph of converted.paragraphs) {
    if (paragraph.heading) {
      requests.push({
        updateParagraphStyle: {
          range: range(paragraph),
          paragraphStyle: { namedStyleType: `HEADING_${paragraph.heading}` },
          fields: 'namedStyleType'
        }
      })
    }
  }
  for (const span of converted.spans.filter((entry) => entry.end > entry.start)) {
    const style = span.bold
      ? { textStyle: { bold: true }, fields: 'bold' }
      : span.italic
        ? { textStyle: { italic: true }, fields: 'italic' }
        : span.link
          ? { textStyle: { link: { url: span.link } }, fields: 'link' }
          : {
              textStyle: { weightedFontFamily: { fontFamily: 'Roboto Mono' } },
              fields: 'weightedFontFamily'
            }
    requests.push({ updateTextStyle: { range: range(span), ...style } })
  }
  // Runs of list items become one list each; last first, since each removes its leading tabs.
  const lists: { start: number; end: number; list: 'bullet' | 'numbered' }[] = []
  for (const paragraph of converted.paragraphs) {
    const previous = lists.at(-1)
    if (!paragraph.list) {
      continue
    }
    if (previous && previous.list === paragraph.list && previous.end + 1 === paragraph.start) {
      previous.end = paragraph.end
    } else {
      lists.push({ start: paragraph.start, end: paragraph.end, list: paragraph.list })
    }
  }
  for (const list of lists.toReversed()) {
    requests.push({
      createParagraphBullets: {
        range: range(list),
        bulletPreset:
          list.list === 'numbered' ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE'
      }
    })
  }
  return requests
}
