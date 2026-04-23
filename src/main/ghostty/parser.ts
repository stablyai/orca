export function parseGhosttyConfig(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) {
      continue
    }

    const key = line.slice(0, eqIndex).trim()
    const value = line.slice(eqIndex + 1).trim()

    if (key) {
      result[key] = value
    }
  }

  return result
}
