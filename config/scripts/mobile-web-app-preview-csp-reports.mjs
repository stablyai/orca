/**
 * Where the preview rig learns that the policy refused something: from the browser's own report,
 * not from a listener inside the frame.
 *
 * The in-frame collector is a page init script, and it can only report what it was present for. In
 * a frame with no `allow-scripts` it observes nothing at all -- the array is there and stays empty
 * while the policy refuses the artifact's image, measured on both engines -- and on CI's Chrome it
 * intermittently missed the `script-src` refusal of a widened frame while catching that same
 * frame's later `img-src` one. A report is sent by the browser itself, so nothing has to have been
 * listening in time, and it arrives for the sealed frame too.
 *
 * Keyed by the arm's nonce, which the document carries in its own URL: every mount loads
 * `/preview?n=<nonce>` and the policy that document is served names `/csp-report?n=<nonce>`, so a
 * report is attributable to the arm that caused it even though a `srcdoc` frame has no URL of its
 * own to name.
 *
 * `report-uri` is additive. It says where a report is sent and changes nothing about what the policy
 * enforces, and the rig pins that by asserting the served directives are the shipped text apart from
 * the one appended here.
 */

const REPORT_PATH = '/csp-report'
const POLL_MS = 25

/** The directive a report names, from either report body shape, or the raw body if it is neither. */
function reportedDirective(body) {
  try {
    const parsed = JSON.parse(body)
    return (
      parsed['csp-report']?.['violated-directive'] ??
      parsed[0]?.body?.effectiveDirective ??
      parsed['csp-report']?.['effective-directive'] ??
      body
    )
  } catch {
    return body
  }
}

export function createCspReportSink() {
  const reports = []
  return {
    reports,
    /** Answers the endpoint the served policy names, and says whether it took the request. */
    handleRequest(request, response, path) {
      if (path !== REPORT_PATH) {
        return false
      }
      const nonce = new URL(request.url, 'http://report').searchParams.get('n')
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        reports.push({
          nonce,
          directive: reportedDirective(Buffer.concat(chunks).toString('utf8'))
        })
        response.writeHead(204)
        response.end()
      })
      return true
    },
    /**
     * The shipped policy plus this document's own endpoint.
     *
     * Absolute, built from the request's own `Host`: a frame that inherits this policy has no URL to
     * resolve a path against, and the port is not known until the server is listening.
     */
    policyFor(csp, request) {
      if (!csp) {
        return csp
      }
      const nonce = new URL(request.url, 'http://page').searchParams.get('n') ?? 'none'
      return `${csp}; report-uri http://${request.headers.host}${REPORT_PATH}?n=${nonce}`
    }
  }
}

/** Every directive this arm's frames were reported for, in arrival order. */
export function reportedDirectives(sink, nonce) {
  return sink.reports.filter((one) => one.nonce === nonce).map((one) => one.directive)
}

/**
 * Waits until this arm has been reported for `directive`.
 *
 * Returns rather than throws on abort, for the reason `untilAborted` does: the reading has already
 * been printed by then and a late rejection has nobody left to catch it.
 */
export async function pollReportsUntil(sink, nonce, directive, signal) {
  while (!signal?.aborted) {
    if (reportedDirectives(sink, nonce).some((one) => one.includes(directive))) {
      return
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, POLL_MS)
      timer.unref?.()
    })
  }
}
