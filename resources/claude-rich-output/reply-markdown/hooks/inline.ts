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

const fence = /^(?:\s*`{3,}|\s*~{3,}|\$\$\s*$)/m
const run = (text: string, at: number) => text.slice(at).match(/^(`+)/)?.[0]

export function inline(text: string, depth = 0): Inline[] {
  if (depth > 12 || fence.test(text)) {
    return [{ text }]
  }
  const result: Inline[] = []
  const literal = (value: string) => {
    const last = result.at(-1)
    if (last && 'text' in last) {
      last.text += value
    } else {
      result.push({ text: value })
    }
  }
  for (let at = 0; at < text.length;) {
    if (text[at] === '\\' && /[\\`*_~[\]<>]/.test(text[at + 1] ?? '')) {
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
        if (
          text.startsWith(delimiter, end) &&
          /\S/.test(text[end - 1] ?? '') &&
          !(delimiter.length === 1 && text[end + 1] === delimiter) &&
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
    }
    literal(text[at]!)
    at++
  }
  return result
}

export const hasStrike = (parts: Inline[]): boolean =>
  parts.some((part) => 'mark' in part && (part.mark === 'strike' || hasStrike(part.children)))
