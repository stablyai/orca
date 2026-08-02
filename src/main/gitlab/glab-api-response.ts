export type GlabApiResponse = {
  body: string
  headers: Record<string, string>
}

/** @internal - exported for tests through gl-utils. */
export function parseGlabApiResponse(stdout: string): GlabApiResponse {
  // Why: response is HTTP status, headers, blank line, then body.
  // Find the first blank line (CRLF or LF) as the boundary.
  const separator = findHeaderBodySeparator(stdout)
  if (!separator) {
    return { body: stdout, headers: {} }
  }
  const headerBlock = stdout.slice(0, separator.index)
  const body = stdout.slice(separator.bodyStart)
  const headers: Record<string, string> = {}
  // Skip the status line and parse the rest as key: value.
  const lines = headerBlock.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/)
    if (m) {
      headers[m[1].toLowerCase()] = m[2].trim()
    }
  }
  return { body, headers }
}

function findHeaderBodySeparator(stdout: string): { index: number; bodyStart: number } | null {
  let lineStart = 0
  for (let index = 0; index < stdout.length; index++) {
    const code = stdout.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }

    const lineEnd = index
    const nextLineStart =
      stdout.charCodeAt(index) === 13 && stdout.charCodeAt(index + 1) === 10 ? index + 2 : index + 1
    if (lineEnd === lineStart) {
      return { index: lineStart, bodyStart: nextLineStart }
    }
    lineStart = nextLineStart
    index = nextLineStart - 1
  }
  return null
}
