import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionStartEndings } from '../native-chat/agent-session-wire/structured-agent-session-start-failure'
import type { StructuredAgentSessionProviderOpenInput } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import type { PiRpcSession } from './rpc-session'
import { piStartFailure } from './rpc-startup-outcome'

/** Takes this child's own exit when first seen, so a start settling meanwhile cannot miss it; the
 *  verdict weighs a failure before it against that exit. */
export function watchPiStartExit(
  session: PiRpcSession,
  input: Pick<StructuredAgentSessionAcquireInput, 'events'>,
  endings: AgentSessionStartEndings
): void {
  const sessionId = session.input.identity.sessionId
  endings.admit(sessionId, session.generation)
  session.connection.onExit((requested, exited) => {
    if (!requested) {
      input.events?.observeRootExit?.()
      endings.record(sessionId, session.generation, piStartFailure([session.failure, exited]))
    }
  })
}

/** A start's open answers with Pi's verdict; a child that already ended answers with how it
 *  ended, and an answer its own exit followed is still worded as that exit. */
export async function openPiStart(
  sessions: Map<string, PiRpcSession>,
  endings: AgentSessionStartEndings,
  input: StructuredAgentSessionProviderOpenInput
): ReturnType<NonNullable<StructuredAgentSessionAdapter['open']>> {
  const session = sessions.get(input.sessionId)
  try {
    if (
      !session ||
      session.input.fence !== input.fence ||
      session.generation !== input.acquisitionGeneration
    ) {
      throw (
        endings.get(input.sessionId, input.acquisitionGeneration) ??
        new Error('Pi child changed before it opened')
      )
    }
    if (session.connection.closed) {
      throw (
        endings.get(input.sessionId, input.acquisitionGeneration) ??
        session.failure ??
        new Error('Pi child ended before it opened')
      )
    }
    return await session.open(input.signal)
  } catch (error) {
    throw piStartFailure(
      error,
      session?.connection.rootVerdict === 'exited' && !session.requestedClose
    )
  }
}

export function piClosedStartError(ending: Error | false | null | undefined): Error {
  return ending || new Error('Pi exited while starting')
}
