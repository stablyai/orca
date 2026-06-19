export type MobileMarkdownBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string; language?: string }
  | { type: 'list'; ordered: boolean; items: Array<{ text: string; checked?: boolean }> }
  | { type: 'image'; alt: string; url: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'rule' }

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

export function parseMobileMarkdown(content: string): MobileMarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MobileMarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^```([A-Za-z0-9_-]+)?\s*$/)
    if (fence) {
      index += 1
      const code: string[] = []
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }
      blocks.push({ type: 'code', text: code.join('\n'), language: fence[1] })
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    const standaloneImage = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)\s*$/i)
    if (standaloneImage) {
      blocks.push({ type: 'image', alt: standaloneImage[1] ?? '', url: standaloneImage[2]! })
      index += 1
      continue
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1] ?? '')
    ) {
      const headers = splitTableRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').includes('|') && lines[index]?.trim()) {
        rows.push(splitTableRow(lines[index] ?? ''))
        index += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() })
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'quote', text: quote.join('\n').trim() })
      continue
    }

    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const items: Array<{ text: string; checked?: boolean }> = []
      let ordered = false
      while (index < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[index] ?? '')) {
        const current = lines[index] ?? ''
        const orderedMatch = current.match(/^\s*\d+[.)]\s+(.+)$/)
        const unorderedMatch = current.match(/^\s*[-*+]\s+(.+)$/)
        ordered ||= Boolean(orderedMatch)
        const rawText = (orderedMatch?.[1] ?? unorderedMatch?.[1] ?? '').trim()
        const task = rawText.match(/^\[([ xX])\]\s+(.+)$/)
        items.push({
          text: task?.[2] ?? rawText,
          checked: task ? task[1]?.toLowerCase() === 'x' : undefined
        })
        index += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index]?.trim() &&
      !(lines[index] ?? '').startsWith('```') &&
      !/^(#{1,6})\s+/.test(lines[index] ?? '') &&
      !/^>\s?/.test(lines[index] ?? '') &&
      !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[index] ?? '') &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '')
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n').trim() })
  }

  return blocks
}
