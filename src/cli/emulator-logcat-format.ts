type LogcatRow = { timestamp?: string; level?: string; tag?: string; message?: string }

export function formatLogcat(value: unknown): string {
  const entries = Array.isArray(value) ? (value as LogcatRow[]) : []
  if (entries.length === 0) {
    return 'No logcat output.'
  }
  return entries
    .map((entry) => {
      const prefix = [entry.timestamp, entry.level, entry.tag].filter(Boolean).join(' ')
      if (!prefix) {
        return entry.message ?? ''
      }
      return entry.message ? `${prefix}: ${entry.message}` : prefix
    })
    .join('\n')
}
