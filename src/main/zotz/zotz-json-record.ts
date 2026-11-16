export type JsonRecord = Record<string, unknown>

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// PowerShell 5.1 writes a BOM in front of UTF-8 files.
function withoutByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Output of external tools (Tailscale, PowerShell, the setup script) is untrusted text. */
export function parseJsonRecord(text: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(withoutByteOrderMark(text).trim())
    return isJsonRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
