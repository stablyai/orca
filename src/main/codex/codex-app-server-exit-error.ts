// What a dead `codex app-server` child means to whoever was talking to it. The
// stderr tail is the only evidence: a CLI without the subcommand is a durable
// capability fact, and anything else is this run's crash.

import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import { stderrIndicatesMissingAppServer } from './codex-app-server-capability-signal'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'

const EXIT_DETAIL_MAX_CHARS = 400

export function buildCodexAppServerExitError(stderrTail: string, cause?: Error): Error {
  const tail = stderrTail.trim().slice(0, EXIT_DETAIL_MAX_CHARS)
  // The tail is Codex's own stderr: a log, kept behind Details.
  const diagnostic = providerDiagnostic(tail, 'log')
  if (stderrIndicatesMissingAppServer(stderrTail)) {
    return withProviderDiagnostic(
      new CodexAppServerUnsupportedError(
        `codex CLI does not support the app-server subcommand: ${tail}`
      ),
      diagnostic
    )
  }
  const detail = cause ? `: ${cause.message}` : tail ? `: ${tail}` : ''
  const error = new Error(`codex app-server connection ended${detail}`)
  return cause ? error : withProviderDiagnostic(error, diagnostic)
}
