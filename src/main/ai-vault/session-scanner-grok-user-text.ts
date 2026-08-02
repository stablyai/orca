// Shared Grok user-turn text helpers for AI Vault (list preview + full first-prompt
// copy). Kept out of the native-chat decoder so vault scanners stay free of that
// dependency while matching its bootstrap / user_query rules.

/**
 * Prefer the body of a Grok `<user_query>` envelope when present (closing tag
 * optional). Bootstrap `<user_info>`-only rows return null so a later real ask
 * can seed the first prompt.
 */
export function extractGrokFirstUserPromptText(value: unknown): string | null {
  const raw = flattenGrokUserContent(value)
  if (!raw) {
    return null
  }
  if (isGrokBootstrapContextText(raw)) {
    return null
  }
  const unwrapped = stripGrokUserQueryEnvelope(raw)
  const trimmed = unwrapped.trim()
  if (!trimmed || isGrokBootstrapContextText(trimmed)) {
    return null
  }
  // Why: if the turn is still just a user_info dump (no query envelope), it is
  // not the prompt the user typed and must not be copied as "first prompt".
  if (
    startsWithIgnoreCaseTag(trimmed, 'user_info') &&
    !containsIgnoreCaseTag(trimmed, 'user_query')
  ) {
    return null
  }
  return trimmed
}

function flattenGrokUserContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return null
  }
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (!item || typeof item !== 'object') {
      continue
    }
    const record = item as Record<string, unknown>
    if (typeof record.type === 'string' && record.type !== 'text') {
      continue
    }
    if (typeof record.text === 'string') {
      parts.push(record.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

export function stripGrokUserQueryEnvelope(text: string): string {
  const opener = '<user_query>'
  const closer = '</user_query>'
  const lower = text.toLowerCase()
  const start = lower.indexOf(opener)
  if (start === -1) {
    return text
  }
  const bodyStart = start + opener.length
  const end = lower.indexOf(closer, bodyStart)
  // Why: incomplete closing tag still holds the real ask after the opener.
  if (end === -1) {
    return text.slice(bodyStart).trim()
  }
  return text.slice(bodyStart, end).trim()
}

export function isGrokBootstrapContextText(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized.startsWith('<user_info>')) {
    return false
  }
  const userInfoEnd = normalized.indexOf('</user_info>')
  if (userInfoEnd === -1) {
    // Open-ended user_info dump with no query: treat as bootstrap noise.
    return !normalized.includes('<user_query>')
  }
  const remainder = normalized.slice(userInfoEnd + '</user_info>'.length).trim()
  // Why: Grok appends a git snapshot to the bootstrap row; reject that envelope
  // so real prompts mentioning either tag still count as user asks.
  return (
    remainder.length === 0 ||
    (remainder.startsWith('<git_status>') && remainder.endsWith('</git_status>'))
  )
}

function startsWithIgnoreCaseTag(text: string, tagName: string): boolean {
  const lower = text.trimStart().toLowerCase()
  return lower.startsWith(`<${tagName}>`) || lower.startsWith(`<${tagName} `)
}

function containsIgnoreCaseTag(text: string, tagName: string): boolean {
  return text.toLowerCase().includes(`<${tagName}>`)
}
