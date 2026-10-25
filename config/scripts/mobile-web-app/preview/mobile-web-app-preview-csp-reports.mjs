// Use browser CSP reports: sealed-frame init listeners see nothing, and widened Chrome frames can miss early script-src violation.
// Match document/report-endpoint nonce to attribute URL-less srcdoc reports per arm. report-uri changes reporting only; rig checks other directives unchanged.

const REPORT_PATH = '/csp-report'
const POLL_MS = 25

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
    // Build absolute report endpoint from request Host; inherited srcdoc policy has no own URL base and port is known only after listen.
    policyFor(csp, request) {
      if (!csp) {
        return csp
      }
      const nonce = new URL(request.url, 'http://page').searchParams.get('n') ?? 'none'
      return `${csp}; report-uri http://${request.headers.host}${REPORT_PATH}?n=${nonce}`
    }
  }
}

export function reportedDirectives(sink, nonce) {
  return sink.reports.filter((one) => one.nonce === nonce).map((one) => one.directive)
}

// Return on abort: diagnosis already printed and late rejection would have no remaining waiter.
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
