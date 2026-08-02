// Why: the composer offers two kinds of autocomplete — `@file` mentions and
// `/slash` commands. Detection is pure (text + cursor → active trigger) so it's
// unit-testable and the composer stays a thin view over it.

export type AutocompleteKind = 'file' | 'slash'

export type AutocompleteTrigger = {
  kind: AutocompleteKind
  /** The query typed after the trigger char (may be empty). */
  query: string
  /** Index of the trigger char in the text (inclusive). */
  start: number
  /** Index just past the cursor / token end (exclusive) — the replace span end. */
  end: number
}

const TOKEN_CHAR = /[^\s]/

/** Detect an active autocomplete trigger at the cursor. A `@` mention triggers
 *  anywhere it follows whitespace/start; a `/` command only at the very start of
 *  the input (slash commands are line-leading). Returns null when the cursor is
 *  not inside such a token. */
export function detectAutocompleteTrigger(
  text: string,
  cursor: number
): AutocompleteTrigger | null {
  const pos = Math.max(0, Math.min(cursor, text.length))
  // Walk left from the cursor over non-whitespace token chars to find the trigger.
  let i = pos - 1
  while (i >= 0 && TOKEN_CHAR.test(text[i]!)) {
    i--
  }
  const triggerIndex = i + 1
  const triggerChar = text[triggerIndex]
  if (triggerChar !== '@' && triggerChar !== '/') {
    return null
  }
  const before = triggerIndex === 0 ? '' : text[triggerIndex - 1]!
  if (triggerChar === '/' && triggerIndex !== 0) {
    // Slash commands are only offered at the very start of the message.
    return null
  }
  if (triggerChar === '@' && triggerIndex !== 0 && !/\s/.test(before)) {
    return null
  }
  const query = text.slice(triggerIndex + 1, pos)
  // A space in the query means the token already closed.
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

/** Replace the trigger span with `value`, leaving a trailing space and the
 *  cursor after it. Returns the new text and the new cursor position. */
export function applyAutocomplete(
  text: string,
  trigger: AutocompleteTrigger,
  value: string
): { text: string; cursor: number } {
  const inserted = `${value} `
  const next = text.slice(0, trigger.start) + inserted + text.slice(trigger.end)
  return { text: next, cursor: trigger.start + inserted.length }
}

/** Rank suggestions for a query: case-insensitive, prefix matches first, then
 *  substring matches, capped. Used for both file paths and command names. */
export function rankSuggestions(candidates: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase()
  if (q.length === 0) {
    return candidates.slice(0, limit)
  }
  const prefix: string[] = []
  const substring: string[] = []
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    const base = lower.split('/').pop() ?? lower
    if (lower.startsWith(q) || base.startsWith(q)) {
      prefix.push(candidate)
    } else if (lower.includes(q)) {
      substring.push(candidate)
    }
    if (prefix.length >= limit) {
      break
    }
  }
  return [...prefix, ...substring].slice(0, limit)
}
