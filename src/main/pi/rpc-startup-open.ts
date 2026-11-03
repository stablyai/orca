import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionStartEndings } from '../native-chat/agent-session-wire/structured-agent-session-start-failure'
import type { StructuredAgentSessionProviderOpenInput } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import { JsonlRpcAgentExitError } from '../jsonl-rpc/agent-connection'
import type { PiRpcSession } from './rpc-session'
import { piStartFailure } from './rpc-startup-outcome'

/** Takes this child's own exit when first seen, so a start settling meanwhile cannot miss it; a
 *  protocol failure before it stays the cause. */
export function watchPiStartExit(
  session: PiRpcSession,
  input: Pick<StructuredAgentSessionAcquireInput, 'events'>,
  endings: AgentSessionStartEndings
): void {
  const sessionId = session.input.identity.sessionId
  endings.forget(sessionId)
  session.connection.onExit((requested) => {
    if (!requested) {
      input.events?.observeRootExit?.()
      const exited = new JsonlRpcAgentExitError('Pi exited while starting')
      endings.record(sessionId, session.generation, piStartFailure(session.failure ?? exited))
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
      throw session.failure ?? new Error('Pi child ended before it opened')
    }
    return await session.open(input.signal)
  } catch (error) {
    throw piStartFailure(
      error,
      session?.connection.rootVerdict === 'exited' && !session.requestedClose
    )
  }
}
