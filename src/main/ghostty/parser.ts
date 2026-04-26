function stripInlineComment(value: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const prev = i > 0 ? value[i - 1] : ''
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === '#' && !inSingle && !inDouble && (prev === ' ' || prev === '\t')) {
      return value.slice(0, i).trim()
    }
  }
  return value.trim()
}

export function parseGhosttyConfig(content: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) {
      continue
    }

    const key = line.slice(0, eqIndex).trim()
    let value = line.slice(eqIndex + 1).trim()

    // Strip inline comments — Ghostty allows # after value unless it's inside quotes.
    // A # is treated as a comment only when preceded by whitespace, so hex values
    // like #1a1a1a at the start of the value are preserved.
    value = stripInlineComment(value)

    // Ghostty allows quoted string values; strip surrounding quotes like Ghostty's own parser does.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (!key) {
      continue
    }

    const existing = result[key]
    if (existing === undefined) {
      result[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      result[key] = [existing, value]
    }
  }

  return result
}
