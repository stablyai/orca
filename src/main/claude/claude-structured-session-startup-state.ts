// Where a Claude start stands. A session is published once its child is spawned, launched with the
// chat's saved options, before the CLI has answered initialize. Messages are written to it at once
// (the CLI queues them behind its start); only an option write, a control request initialize must
// answer first, waits for startup to land.

import type { SubmissionRejectionFact } from '../../shared/agent-session-failure'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import type { ClaudeSession } from './claude-structured-session-state'

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

export function claudeStartupFailureFact(session: ClaudeSession): SubmissionRejectionFact | null {
  return session.startup.state === 'failed'
    ? providerStartupFailureFact(session.startup.failure ?? undefined)
    : null
}

/** Resolves when startup lands or `timeoutMs` passes; a stuck start then refuses the write as before. */
export function claudeStartupSettledWithin(
  session: ClaudeSession | undefined,
  timeoutMs: number
): Promise<void> {
  if (session?.startup.state !== 'pending') {
    return Promise.resolve()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    session.startup.settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
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
