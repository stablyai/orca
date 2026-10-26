export type AutocompleteKind = 'file' | 'slash'

export type AutocompleteTrigger = {
  kind: AutocompleteKind
  query: string
  start: number
  end: number
}

const TOKEN_CHAR = /[^\s]/

export function detectAutocompleteTrigger(
  text: string,
  cursor: number
): AutocompleteTrigger | null {
  const pos = Math.max(0, Math.min(cursor, text.length))
  let i = pos - 1
  while (i >= 0 && TOKEN_CHAR.test(text[i]!)) {
    i--
  }
  const triggerIndex = i + 1
  if (pos <= triggerIndex) {
    return null
  }
  const triggerChar = text[triggerIndex]
  if (triggerChar !== '@' && triggerChar !== '/') {
    return null
  }
  const before = triggerIndex === 0 ? '' : text[triggerIndex - 1]!
  if (triggerChar === '/' && triggerIndex !== 0) {
    return null
  }
  if (triggerChar === '@' && triggerIndex !== 0 && !/\s/.test(before)) {
    return null
  }
  const query = text.slice(triggerIndex + 1, pos)
  if (/\s/.test(query)) {
    return null
  }
  return {
    kind: triggerChar === '@' ? 'file' : 'slash',
    query,
    start: triggerIndex,
    end: pos
  }
}

export function applyAutocomplete(
  text: string,
  trigger: AutocompleteTrigger,
  value: string
): { text: string; cursor: number } {
  const inserted = `${value} `
  const next = text.slice(0, trigger.start) + inserted + text.slice(trigger.end)
  return { text: next, cursor: trigger.start + inserted.length }
}

export function rankSuggestions(candidates: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase()
  if (q.length === 0) {
    return candidates.slice(0, limit)
  }
  const prefix: string[] = []
  const substring: string[] = []
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    const base = lower.slice(lower.lastIndexOf('/') + 1)
    if (lower.startsWith(q) || base.startsWith(q)) {
      prefix.push(candidate)
    } else if (substring.length < limit && lower.includes(q)) {
      substring.push(candidate)
    }
    if (prefix.length >= limit) {
      break
    }
  }
  return [...prefix, ...substring].slice(0, limit)
}
