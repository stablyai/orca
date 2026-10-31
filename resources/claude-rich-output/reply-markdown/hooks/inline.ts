import { FENCE, FORMULA, closesFormula } from './blocks.ts'

// Claude's terminal Markdown leaf supports emphasis but not GFM deletion.
// Only prose containing a deletion uses this inline tree. Code and math
// blocks continue through their existing, literal/block renderers.
export type Inline =
  | { text: string }
  | { code: string }
  | {
      mark: 'bold' | 'italic' | 'strike' | 'link'
      children: Inline[]
      href?: string
    }

const hasBlockSyntax = (text: string) => {
  const lines = text.split('\n')
  return lines.some(
    (line, index) => FENCE.test(line) || (FORMULA.test(line) && closesFormula(lines, index))
  )
}
const run = (text: string, at: number) => text.slice(at).match(/^(`+)/)?.[0]

export function inline(text: string, depth = 0): Inline[] {
  if (depth > 12 || hasBlockSyntax(text)) {
    return [{ text }]
  }
  const result: Inline[] = []
  const unmatched = new Set<string>()
  const literal = (value: string) => {
    const last = result.at(-1)
    if (last && 'text' in last) {
      last.text += value
    } else {
      result.push({ text: value })
    }
  }
  for (let at = 0; at < text.length;) {
    if (text[at] === '\\' && /[!-/:-@[-`{-~]/.test(text[at + 1] ?? '')) {
      literal(text[at + 1]!)
      at += 2
      continue
    }
    const ticks = run(text, at)
    if (ticks) {
      let end = text.indexOf(ticks, at + ticks.length)
      while (end >= 0 && (text[end - 1] === '`' || text[end + ticks.length] === '`')) {
        end = text.indexOf(ticks, end + ticks.length)
      }
      if (end >= 0) {
        let code = text.slice(at + ticks.length, end).replaceAll('\n', ' ')
        if (/^ .* $/.test(code) && code.trim() !== '') {
          code = code.slice(1, -1)
        }
        result.push({ code })
        at = end + ticks.length
        continue
      }
      literal(ticks)
      at += ticks.length
      continue
    }
    const link = /^\[([^\]\n]+)\]\(([^\s)]+)\)/.exec(text.slice(at))
    if (link && /^(https?:|file:)/.test(link[2]!)) {
      result.push({ mark: 'link', href: link[2], children: inline(link[1]!, depth + 1) })
      at += link[0].length
      continue
    }
    const delimiter = ['~~', '**', '__', '*', '_'].find((d) => text.startsWith(d, at))
    if (
      delimiter &&
      !unmatched.has(delimiter) &&
      /\S/.test(text[at + delimiter.length] ?? '') &&
      !(delimiter[0] === '_' && /[\p{L}\p{N}]/u.test(text[at - 1] ?? ''))
    ) {
      let end = at + delimiter.length
      for (; end < text.length; end++) {
        if (text[end] === '\\') {
          end++
          continue
        }
        const code = run(text, end)
        if (code) {
          const close = text.indexOf(code, end + code.length)
          if (close !== -1) {
            end = close + code.length - 1
            continue
          }
        }
        if (delimiter.length === 1 && text.startsWith(delimiter + delimiter, end)) {
          end++
          continue
        }
        if (
          text.startsWith(delimiter, end) &&
          /\S/.test(text[end - 1] ?? '') &&
          !(delimiter[0] === '_' && /[\p{L}\p{N}]/u.test(text[end + delimiter.length] ?? ''))
        ) {
          break
        }
      }
      if (end < text.length) {
        const mark = delimiter === '~~' ? 'strike' : delimiter.length === 2 ? 'bold' : 'italic'
        result.push({ mark, children: inline(text.slice(at + delimiter.length, end), depth + 1) })
        at = end + delimiter.length
        continue
      }
      unmatched.add(delimiter)
    }
    literal(text[at]!)
    at++
  }
  return result
}

export const hasStrike = (parts: Inline[]): boolean =>
  parts.some((part) => 'mark' in part && (part.mark === 'strike' || hasStrike(part.children)))

// CommonMark closes a `**` only where punctuation inside it does not meet a
// letter outside, and Chinese sets no space after its stops: `**收斂。**記憶`
// is drawn as written. Moving the punctuation out (`**收斂**。記憶`) draws it
// bold. A code span is matched first and kept whole, inside bold or not.
// ponytail: one line at a time, single-backtick code spans inside bold; a
// bold run across a line break, and `***bold italic***`, are left as written.
const BOLD =
  /(`+)[^`\n]*?\1(?!`)|\*\*((?:(?!\*)\p{P})*)((?:`[^`\n]*`|[^*`\n])*?)((?:(?!\*)\p{P})*)\*\*/gu
const ENDS_IN_LETTER = /[^\s\p{P}\p{S}]$/u
const STARTS_WITH_LETTER = /^[^\s\p{P}\p{S}]/u

/** The text with each bold run closable, its fences and `$$` formulas left as written. */
export function holdBold(text: string) {
  let fence: string | undefined
  const lines = text.split('\n')

  return lines
    .map((line, index) => {
      const run =
        FENCE.exec(line)?.[1] ??
        (FORMULA.test(line) && (fence !== undefined || closesFormula(lines, index))
          ? '$$'
          : undefined)
      if (fence !== undefined) {
        if (
          run !== undefined &&
          run[0] === fence[0] &&
          run.length >= fence.length &&
          line.trim() === run
        ) {
          fence = undefined
        }

        return line
      }
      fence = run

      return run !== undefined
        ? line
        : line.replace(BOLD, (whole, ticks?: string, lead = '', body = '', trail = '', at = 0) => {
            const isStuck =
              (lead !== '' && ENDS_IN_LETTER.test(line.slice(0, at))) ||
              (trail !== '' && STARTS_WITH_LETTER.test(line.slice(at + whole.length)))

            return ticks !== undefined || !isStuck || body === '' || body.trim() !== body
              ? whole
              : `${lead}**${body}**${trail}`
          })
    })
    .join('\n')
}
