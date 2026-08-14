export function isAppServerRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCodexAppServerJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return isAppServerRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
