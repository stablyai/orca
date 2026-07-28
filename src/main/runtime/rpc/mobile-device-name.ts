const MAX_REPORTED_DEVICE_NAME_LENGTH = 64

export function sanitizeReportedDeviceName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = Array.from(raw)
    .filter((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  // Why: String.slice counts UTF-16 code units and can leave a lone surrogate
  // at the boundary; match the mobile sender's code-point limit.
  const cleaned = Array.from(normalized).slice(0, MAX_REPORTED_DEVICE_NAME_LENGTH).join('')
  return cleaned.length > 0 ? cleaned : null
}
