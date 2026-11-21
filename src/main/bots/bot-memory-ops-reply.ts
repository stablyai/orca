// A tidy-up's reply on ops: the one JSON array of operations in it, read the way JSON reads.

/** Each top-level bracketed span of `text`, read the way JSON reads strings, so brackets inside a
 *  string or a nested array never start or end one; an unclosed span is none. */
function topLevelArrays(text: string): string[] {
  const spans: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"' && depth > 0) {
      inString = true
    } else if (char === '[') {
      start = depth === 0 ? at : start
      depth += 1
    } else if (char === ']' && depth > 0) {
      depth -= 1
      if (depth === 0) {
        spans.push(text.slice(start, at + 1))
      }
    }
  }
  return spans
}

/** The reply's ops: every fenced block's whole payload, else the one top-level array in the reply that
 *  parses; null when there is none or more than one (nothing from the model applies). */
export function parseTidyUpOps(reply: string): unknown[] | null {
  // Every fence, whatever its info string ("json", "text", none), each paired with its own close.
  const fenced = [...reply.matchAll(/^\s*```[^\n`]*\n([\s\S]*?)^\s*```/gm)].map((match) =>
    match[1].trim()
  )
  const arrays = (fenced.length > 0 ? fenced : topLevelArrays(reply)).flatMap((span) => {
    try {
      const parsed: unknown = JSON.parse(span)
      return Array.isArray(parsed) ? [parsed] : []
    } catch {
      return []
    }
  })
  return arrays.length === 1 ? arrays[0] : null
}
