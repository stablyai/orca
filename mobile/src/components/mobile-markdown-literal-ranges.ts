import type MarkdownIt from 'markdown-it'

type SourceRange = { start: number; end: number }

function inlineLiteralRanges(
  source: string,
  markdown: MarkdownIt,
  env: Record<string, unknown>
): SourceRange[] {
  const state = new markdown.inline.State(source, markdown, env, [])
  const ranges: SourceRange[] = []
  while (state.pos < state.posMax) {
    const start = state.pos
    // The parser skips HTML attributes, escapes and link destinations before pairing backticks.
    markdown.inline.skipToken(state)
    if (source[start] === '`') {
      let openerEnd = start
      while (source[openerEnd] === '`') {
        openerEnd++
      }
      if (state.pos > openerEnd) {
        ranges.push({ start, end: state.pos })
      }
    } else if (state.pos > start + 1 && ['<', '[', '!'].includes(source[start]!)) {
      ranges.push({ start, end: state.pos })
    }
  }
  return ranges
}

/** Ranges in the original source where attachment-looking text belongs to Markdown markup. */
export function collectMobileMarkdownLiteralRanges(
  source: string,
  tokens: ReturnType<MarkdownIt['parse']>,
  markdown: MarkdownIt,
  env: Record<string, unknown>
): SourceRange[] {
  let offset = 0
  const lines = source.split('\n').map((line) => {
    const start = offset
    offset += line.length + 1
    return start
  })
  const ranges: SourceRange[] = []
  for (const token of tokens) {
    if (!token.map) {
      continue
    }
    const start = lines[token.map[0]] ?? source.length
    const end = lines[token.map[1]] ?? source.length
    if (['fence', 'code_block', 'html_block', 'table_open'].includes(token.type)) {
      ranges.push({ start, end })
    } else if (token.type === 'inline') {
      ranges.push(
        ...inlineLiteralRanges(source.slice(start, end), markdown, env).map((span) => ({
          start: start + span.start,
          end: start + span.end
        }))
      )
    }
  }
  return ranges.sort((a, b) => a.start - b.start)
}
