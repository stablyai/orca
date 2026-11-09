/** Fields of `claude auth status --json` Orca reads; tokens are never part of it. */
export type ClaudeAuthStatusReport = {
  loggedIn?: boolean
  authMethod?: string
  apiKeySource?: string
  projectsDirectory?: string
}

const STRING_FIELDS = ['authMethod', 'apiKeySource', 'projectsDirectory'] as const

/** Parses `claude auth status --json`; null when the output is not one JSON object. */
export function parseClaudeAuthStatusReport(stdout: string): ClaudeAuthStatusReport | null {
  const start = stdout.search(/[[{]/)
  if (start === -1) {
    return null
  }
  // CLI warnings may precede the report, but another JSON value makes it ambiguous.
  for (const line of stdout.slice(0, start).split('\n')) {
    try {
      JSON.parse(line)
      return null
    } catch {
      continue
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const report: ClaudeAuthStatusReport = {}
  if ('loggedIn' in parsed && typeof parsed.loggedIn === 'boolean') {
    report.loggedIn = parsed.loggedIn
  }
  for (const field of STRING_FIELDS) {
    const value = Object.getOwnPropertyDescriptor(parsed, field)?.value
    if (typeof value === 'string') {
      report[field] = value
    }
  }
  return report
}
