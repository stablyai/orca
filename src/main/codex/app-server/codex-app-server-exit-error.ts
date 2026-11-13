// A missing subcommand is a durable capability result; other exits remain failures of this run.
import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'
import { stderrIndicatesMissingAppServer } from './codex-app-server-capability-signal'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import { providerStderrForDisplay } from '../../provider-process/provider-spawn-failure-report'

const EXIT_DETAIL_MAX_CHARS = 400

/** The transport ended. Protocol failures are Orca refusing what Codex wrote, so not an exit. */
export class CodexAppServerExitError extends Error {
  constructor(
    message: string,
    readonly protocolFailure = false
  ) {
    super(message)
    this.name = 'CodexAppServerExitError'
  }
}

export function buildCodexAppServerExitError(
  stderrTail: string,
  cause?: Error,
  protocolFailure = false
): Error {
  const tail = providerStderrForDisplay(stderrTail).trim().slice(0, EXIT_DETAIL_MAX_CHARS)
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
  const error = new CodexAppServerExitError(
    `codex app-server connection ended${detail}`,
    protocolFailure
  )
  return cause ? error : withProviderDiagnostic(error, diagnostic)
}
