// Field readers for the loosely-typed records Codex sends on thread items.

export function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readFirstString(
  source: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = readString(source, key)
    if (value !== null) {
      return value
    }
  }
  return null
}

export function readTextContent(source: Record<string, unknown>, key: string): string | null {
  const direct = readString(source, key)
  if (direct) {
    return direct
  }
  const value = source[key]
  if (!Array.isArray(value)) {
    return null
  }
  const parts = value.flatMap((part) => {
    if (typeof part === 'string') {
      return part.length > 0 ? [part] : []
    }
    if (typeof part !== 'object' || part === null) {
      return []
    }
    const text = readString(part as Record<string, unknown>, 'text')
    return text ? [text] : []
  })
  return parts.length > 0 ? parts.join('\n') : null
}
