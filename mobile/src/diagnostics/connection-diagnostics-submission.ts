const CONNECTION_DIAGNOSTICS_ENDPOINT = 'https://www.onorca.dev/v1/feedback'
const SUBMISSION_TIMEOUT_MS = 10_000
const MAX_SUBMISSION_BYTES = 64 * 1024

export type ConnectionDiagnosticsSubmission = {
  report: string
  appVersion: string
  platform: string
}

export type ConnectionDiagnosticsSubmissionResult = { ok: true } | { ok: false; error: string }

/** Sends only the already-redacted, bounded report after an explicit user tap. */
export async function submitConnectionDiagnostics(
  submission: ConnectionDiagnosticsSubmission,
  fetchImpl: typeof fetch = fetch
): Promise<ConnectionDiagnosticsSubmissionResult> {
  const report = boundConnectionDiagnosticsReport(submission.report)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUBMISSION_TIMEOUT_MS)
  try {
    const response = await fetchImpl(CONNECTION_DIAGNOSTICS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedback: report,
        submissionType: 'connection_diagnostics',
        githubLogin: null,
        githubEmail: null,
        appVersion: submission.appVersion,
        platform: `mobile-${submission.platform}`,
        osRelease: 'unknown',
        arch: 'unknown'
      }),
      signal: controller.signal
    })
    return response.ok ? { ok: true } : { ok: false, error: `status ${response.status}` }
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? 'request timed out'
        : error instanceof Error
          ? error.message
          : 'request failed'
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function boundConnectionDiagnosticsReport(
  report: string,
  maxBytes: number = MAX_SUBMISSION_BYTES
): string {
  if (utf8Bytes(report) <= maxBytes) {
    return report
  }
  const lines = report.split('\n')
  const historyIndex = lines.findIndex((line) => line.startsWith('Recent connection history ('))
  if (historyIndex === -1) {
    return truncateUtf8(report, maxBytes)
  }
  const header = lines.slice(0, historyIndex)
  const events = lines.slice(historyIndex + 1)
  let kept: string[] = []
  for (let index = events.length - 1; index >= 0; index--) {
    const candidateEvents = [events[index]!, ...kept]
    const candidate = formatBoundedReport(header, candidateEvents, events.length)
    if (utf8Bytes(candidate) > maxBytes) {
      break
    }
    kept = candidateEvents
  }
  if (kept.length === 0 && events.length > 0) {
    return formatReportWithTruncatedNewestEvent(header, events, maxBytes)
  }
  return truncateUtf8(formatBoundedReport(header, kept, events.length), maxBytes)
}

function formatReportWithTruncatedNewestEvent(
  header: string[],
  events: string[],
  maxBytes: number
): string {
  const history = `Recent connection history (1 newest event; ${events.length - 1} older omitted):`
  const prefix = [...header, history].join('\n') + '\n'
  const availableBytes = maxBytes - utf8Bytes(prefix)
  if (availableBytes <= 0) {
    return truncateUtf8(prefix, maxBytes)
  }
  const marker = ' … [truncated]'
  const markerBytes = utf8Bytes(marker)
  if (availableBytes <= markerBytes) {
    return truncateUtf8(prefix, maxBytes)
  }
  return `${prefix}${truncateUtf8(events.at(-1)!, availableBytes - markerBytes)}${marker}`
}

function formatBoundedReport(header: string[], events: string[], totalEvents: number): string {
  const omitted = totalEvents - events.length
  return [
    ...header,
    `Recent connection history (${events.length} newest events; ${omitted} older omitted):`,
    ...events
  ].join('\n')
}

function truncateUtf8(value: string, maxBytes: number): string {
  const characters: string[] = []
  let bytes = 0
  for (const character of value) {
    const characterBytes = utf8Bytes(character)
    if (bytes + characterBytes > maxBytes) {
      break
    }
    characters.push(character)
    bytes += characterBytes
  }
  return characters.join('')
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
