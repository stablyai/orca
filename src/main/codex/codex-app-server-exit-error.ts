// What a dead `codex app-server` child means to whoever was talking to it. The
// stderr tail is the only evidence: a CLI without the subcommand is a durable
// capability fact, and anything else is this run's crash.

import { stderrIndicatesMissingAppServer } from './codex-app-server-capability-signal'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'

const EXIT_DETAIL_MAX_CHARS = 400

export function buildCodexAppServerExitError(stderrTail: string, cause?: Error): Error {
  const tail = stderrTail.trim().slice(0, EXIT_DETAIL_MAX_CHARS)
  if (stderrIndicatesMissingAppServer(stderrTail)) {
    return new CodexAppServerUnsupportedError(
      `codex CLI does not support the app-server subcommand: ${tail}`
    )
  }
  const detail = cause ? `: ${cause.message}` : tail ? `: ${tail}` : ''
  return new Error(`codex app-server connection ended${detail}`)
}
