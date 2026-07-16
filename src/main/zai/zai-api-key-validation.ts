export const MAX_ZAI_API_KEY_BYTES = 4096

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

export function validateZaiApiKey(apiKey: string): string {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Z.ai API key is required')
  }
  // Why: keep persisted secrets within a generous but bounded size so malformed
  // paste events or binary junk cannot balloon main-process memory/disk usage.
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_ZAI_API_KEY_BYTES) {
    throw new Error(`Z.ai API key must be at most ${MAX_ZAI_API_KEY_BYTES} bytes`)
  }
  if (hasAsciiControlCharacter(trimmed)) {
    throw new Error('Z.ai API key contains unsupported control characters')
  }
  return trimmed
}
