// Where a Claude start stands. A session is published once its child is spawned, before the CLI
// has answered initialize. Nothing is written to it until startup lands (init facts read and saved
// options restored): the host's delivery loop waits on `settled` before it hands a message over,
// so a first turn never runs under defaults the restore was about to replace.

import type { SubmissionRejectionFact } from '../../shared/agent-session-failure'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import type { ClaudeSession } from './claude-structured-session-state'

export type ClaudeSessionStartup = {
  state: 'pending' | 'proven' | 'failed'
  failure: Error | null
  /** Resolves once startup has landed or faulted, or the child exited or was closed; never
   *  rejects. A close must end it: the delivery loop waits here, and a start Stop cut short
   *  would otherwise hold that loop forever. */
  settled: Promise<void>
  end: () => void
}

export function createClaudeSessionStartup(): ClaudeSessionStartup {
  let end: () => void = () => undefined
  const ended = new Promise<void>((resolve) => {
    end = resolve
  })
  return { state: 'pending', failure: null, settled: ended, end }
}

export function claudeStartupFailureFact(session: ClaudeSession): SubmissionRejectionFact | null {
  return session.startup.state === 'failed'
    ? providerStartupFailureFact(session.startup.failure ?? undefined)
    : null
}

export async function awaitClaudeSessionStarted(
  session: ClaudeSession | undefined
): Promise<void | SubmissionRejectionFact> {
  if (!session) {
    return
  }
  await session.startup.settled
  return claudeStartupFailureFact(session) ?? undefined
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
