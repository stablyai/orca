export type GlabApiResponse = {
  body: string
  headers: Record<string, string>
}

/** @internal - exported for tests through gl-utils. */
export function parseGlabApiResponse(stdout: string): GlabApiResponse {
  // HTTP headers end at the first blank line, accepting either CRLF or LF.
  const separator = findHeaderBodySeparator(stdout)
  if (!separator) {
    return { body: stdout, headers: {} }
  }
  const headerBlock = stdout.slice(0, separator.index)
  const body = stdout.slice(separator.bodyStart)
  const headers: Record<string, string> = {}
  const lines = headerBlock.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/)
    if (m) {
      headers[m[1].toLowerCase()] = m[2].trim()
    }
  }
  return { body, headers }
}

/** A GitLab pagination header, or undefined when absent, unparseable, or below `minimum`. */
export function parseGlabPaginationHeader(
  value: string | undefined,
  minimum: number
): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : undefined
}

/** A non-list body carrying no GitLab error text — opaque data, so there is nothing to classify. */
export class GlabNonListResponseError extends Error {}

// Bound diagnostics before multi-megabyte proxy bodies reach the error banner.
const REPORTED_PAYLOAD_LIMIT = 300

/** glab can exit 0 with an error object or proxy wrapper; distinguish it from a valid list before mapping. */
export function parseGlabJsonList<T>(payload: string): T[] {
  const parsed: unknown = JSON.parse(payload)
  if (Array.isArray(parsed)) {
    return parsed as T[]
  }
  const reported = gitlabErrorText(parsed)
  if (reported) {
    throw new Error(`GitLab returned an error: ${reported}`)
  }
  // Slice original bytes without serializing a multi-megabyte parsed object for its preview.
  throw new GlabNonListResponseError(
    `GitLab returned a non-list response: ${payload.trim().slice(0, REPORTED_PAYLOAD_LIMIT)}`
  )
}

/** GitLab reports API failures as `{ message }` or `{ error }`; anything else is opaque data. */
function gitlabErrorText(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const { message, error } = parsed as { message?: unknown; error?: unknown }
  for (const value of [message, error]) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, REPORTED_PAYLOAD_LIMIT)
    }
  }
  return null
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
