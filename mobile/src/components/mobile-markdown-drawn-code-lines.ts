import { detailsPieces } from './mobile-markdown-details'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { markdownTokens, mobileMarkdownCodeLines, withoutComments } from './mobile-markdown-tree'

const ENV = { chatMath: false }
const isCode = (type: string): boolean => type === 'fence' || type === 'code_block'

function lineCounts(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    counts.set(line.trim(), (counts.get(line.trim()) ?? 0) + 1)
  }
  return counts
}

/** The 0-based lines drawn as code, adding those parseMobileMarkdownTree reparses out of HTML. */
export function mobileMarkdownDrawnCodeLines(source: string): Set<number> {
  const lines = mobileMarkdownCodeLines(source)
  for (const token of markdownTokens(source, ENV)) {
    if (token.type !== 'html_block' || !token.map) {
      continue
    }
    const firstLine = token.map[0]
    const reparsed = detailsPieces(token.content).flatMap((piece) =>
      piece.kind === 'html'
        ? markdownTokens(normalizeMobileMarkdownPreviewHtml(withoutComments(piece.value)), ENV)
        : []
    )
    const codeCounts = lineCounts(
      reparsed.flatMap((inner) => (isCode(inner.type) ? inner.content.split('\n') : []))
    )
    const blockLines = token.content.split('\n')
    const blockCounts = lineCounts(blockLines)
    // Why: normalizing moves lines, so code maps back by text; a line also used as prose stays prose.
    blockLines.forEach((text, offset) => {
      const line = text.trim()
      if (line && codeCounts.get(line) === blockCounts.get(line)) {
        lines.add(firstLine + offset)
      }
    })
  }
  return lines
}
