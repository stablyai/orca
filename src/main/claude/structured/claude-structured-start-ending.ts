import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { withObservedProviderExit } from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'
import type {
  AgentSessionStartEndings,
  AgentSessionStartFailure
} from '../../native-chat/agent-session-wire/structured-agent-session-start-failure'
import type {
  StructuredAgentSessionProviderOpenInput,
  StructuredAgentSessionProviderOpenResult
} from '../../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import { openClaudeStructuredSession } from './claude-structured-session-open'
import { claudeStartFailure } from '../claude-startup-failure'
import type { ClaudeSession, ClaudeSessionExit } from './claude-structured-session-state'

/** Publishes an acquisition's session with its start ending admitted first, so its exit is never
 *  missed. A failed acquire has no start owner left, so it retires exactly that admission. */
export function claudeStartPublication(
  sessions: Map<string, ClaudeSession>,
  endings: AgentSessionStartEndings,
  sessionId: string
): { publish: (session: ClaudeSession) => void; failed: () => void } {
  let admitted: string | undefined
  return {
    publish: (session) => {
      admitted = session.acquisitionGeneration
      endings.admit(sessionId, admitted)
      sessions.set(sessionId, session)
    },
    failed: () => {
      if (admitted !== undefined) {
        endings.retire(sessionId, admitted)
      }
    }
  }
}

/** Claude ended on its own: unanswered, unless what ended it was its answer or a refusal. */
export function claudeExitEnding(error: Error): AgentSessionStartFailure {
  return claudeStartFailure(withObservedProviderExit(new Error(error.message, { cause: error })))
}

/** A start's open answers with Claude's verdict. An exit already seen is published first, so the
 *  host never reads the rejection before the exit that explains it. */
export async function openClaudeStart(
  input: Omit<Parameters<typeof openClaudeStructuredSession>[0], 'session'> & {
    exits: Map<string, ClaudeSessionExit>
    endings: AgentSessionStartEndings
  }
): Promise<StructuredAgentSessionProviderOpenResult> {
  const { request } = input
  const session = input.sessions.get(request.sessionId)
  if (!session) {
    throw await claudeEndedStart(
      input.exits.get(request.sessionId)?.session,
      request,
      input.endings
    )
  }
  try {
    return await openClaudeStructuredSession({ ...input, session })
  } catch (error) {
    const exit = input.exits.get(request.sessionId)
    if (exit?.session.acquisitionGeneration === request.acquisitionGeneration && exit.publication) {
      await waitForPromiseWithSignal(exit.publication, request.signal)
    }
    throw claudeStartFailure(error)
  }
}

/** A start that ended before its open answers with its own ending: the cause its startup settled
 *  on once the exit's initialize join finished, else the ending taken at its exit. */
async function claudeEndedStart(
  exited: ClaudeSession | undefined,
  request: StructuredAgentSessionProviderOpenInput,
  endings: AgentSessionStartEndings
): Promise<AgentSessionStartFailure> {
  const { sessionId, acquisitionGeneration, signal } = request
  const { startup } = exited?.initialization ?? {}
  if (exited?.acquisitionGeneration === acquisitionGeneration && startup && !startup.opened()) {
    const ended = await waitForPromiseWithSignal(
      startup.race(new Promise<never>(() => {}), signal).catch((error: unknown) => error),
      signal
    )
    return claudeStartFailure(ended)
  }
  return (
    endings.get(sessionId, acquisitionGeneration) ??
    claudeStartFailure(new Error(`no claude session for ${sessionId}`))
  )
}
