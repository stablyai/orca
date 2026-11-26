/** Extract the user_query body, accepting a missing closer; ignore bootstrap-only user_info rows. */
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
  // Bootstrap context without a query is not a copyable user prompt.
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

// Case-insensitive regex search avoids lowercasing a whole multi-MB prompt to find its tags.
const USER_QUERY_OPENER = /<user_query>/i
const USER_QUERY_CLOSER = /<\/user_query>/gi

export function stripGrokUserQueryEnvelope(text: string): string {
  const start = text.search(USER_QUERY_OPENER)
  if (start === -1) {
    return text
  }
  const bodyStart = start + '<user_query>'.length
  USER_QUERY_CLOSER.lastIndex = bodyStart
  const end = USER_QUERY_CLOSER.exec(text)?.index ?? -1
  // A missing closer can reflect an incomplete write; retain the ask after the opener.
  if (end === -1) {
    return text.slice(bodyStart).trim()
  }
  return text.slice(bodyStart, end).trim()
}

export function isGrokBootstrapContextText(text: string): boolean {
  if (!lowerHead(text, '<user_info>'.length).startsWith('<user_info>')) {
    return false
  }
  const normalized = text.trim().toLowerCase()
  const userInfoEnd = normalized.indexOf('</user_info>')
  if (userInfoEnd === -1) {
    return !normalized.includes('<user_query>')
  }
  const remainder = normalized.slice(userInfoEnd + '</user_info>'.length).trim()
  // Grok may append a git snapshot to bootstrap context; other trailing text can be a real prompt.
  return (
    remainder.length === 0 ||
    (remainder.startsWith('<git_status>') && remainder.endsWith('</git_status>'))
  )
}

function startsWithIgnoreCaseTag(text: string, tagName: string): boolean {
  const head = lowerHead(text, tagName.length + 2)
  return head.startsWith(`<${tagName}>`) || head.startsWith(`<${tagName} `)
}

// Lowercasing a whole multi-MB prompt (slow for sliced strings) only to test its prefix stalls the scan.
function lowerHead(text: string, length: number): string {
  return text.trimStart().slice(0, length).toLowerCase()
}

function containsIgnoreCaseTag(text: string, tagName: string): boolean {
  return text.toLowerCase().includes(`<${tagName}>`)
}
