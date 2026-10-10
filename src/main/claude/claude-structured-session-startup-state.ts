// Where a Claude start stands. A session is published once its child is spawned, launched with the
// chat's saved options, before the CLI has answered initialize. The host hands it no message until
// `started`; an option write, a control request initialize must answer first, waits here too.

import type { SubmissionRejectionFact } from '../../shared/agent-session-failure'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import type { ClaudeSession } from './claude-structured-session-state'
import { withMissingProviderExecutable } from '../provider-process/provider-executable-missing'

export type ClaudeSessionStartup = {
  state: 'pending' | 'proven' | 'failed'
  /** The CLI answered initialize: it may have run what it was handed. Before that it ran nothing. */
  answered: boolean
  failure: Error | null
  /** Resolves once startup has landed or faulted, or the child exited or was closed; never
   *  rejects. A close must end it: an option write waits here. */
  settled: Promise<void>
  end: () => void
}

export function createClaudeSessionStartup(): ClaudeSessionStartup {
  let end: () => void = () => undefined
  const ended = new Promise<void>((resolve) => {
    end = resolve
  })
  return { state: 'pending', answered: false, failure: null, settled: ended, end }
}

/** Why a start failed; a CLI that was never found says so, whichever error the start met first. */
export function claudeStartupFailureCause(
  session: ClaudeSession,
  fallback?: Error
): Error | undefined {
  const failure = session.startup.failure ?? fallback
  return failure && session.connection.executableMissing
    ? withMissingProviderExecutable(failure)
    : failure
}

export function claudeStartupFailureFact(session: ClaudeSession): SubmissionRejectionFact | null {
  return session.startup.state === 'failed'
    ? providerStartupFailureFact(claudeStartupFailureCause(session))
    : null
}

/** Startup cannot land any more: the child exited, was closed, or its start faulted. */
export function failClaudeStartup(session: ClaudeSession, error: Error): void {
  const startup = session.startup
  if (startup.state === 'pending') {
    startup.state = 'failed'
    startup.failure = error
  }
  startup.end()
}
