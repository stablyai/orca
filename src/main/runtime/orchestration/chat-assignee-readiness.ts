/**
 * worker-start's wait for a chat to be able to take a turn: the chat counterpart of a terminal's
 * wait for its agent to go idle, decided by the mail lane's own gate. Nothing is attached before
 * it says yes, exactly as a terminal is attached only once it is idle. It is re-checked at each
 * status change the session host publishes for the chat, so it polls nothing.
 */

import { randomUUID } from 'node:crypto'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { readStructuredSessionGateFacts } from './structured-mailbox-pointer-host'
import {
  decideStructuredSessionPointerDelivery,
  type StructuredPointerDecision
} from './structured-session-pointer-delivery'

export async function awaitChatTakesTurn(
  sessionId: string,
  timeoutMs: number
): Promise<StructuredPointerDecision> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return { deliver: false, retain: 'session-not-attached' }
  }
  let wake = (): void => {}
  const dispose = host.subscribeStatus({
    id: `worker-start-readiness:${randomUUID()}`,
    emit: (event) => {
      // Working and attention edges are dropped as the mail lane drops them: a turn that ends behind
      // an unanswered send is followed by an idle edge, so this only waits out the user's own send.
      if (
        event.type !== 'status' ||
        (event.session.sessionId === sessionId &&
          event.session.status !== 'working' &&
          event.session.status !== 'attention')
      ) {
        wake()
      }
    }
  })
  const deadline = Date.now() + timeoutMs
  try {
    for (;;) {
      // Armed before the read, so an edge landing during it is not missed.
      const edge = new Promise<void>((resolve) => {
        wake = resolve
      })
      const decision = decideStructuredSessionPointerDelivery({
        session: await readStructuredSessionGateFacts(sessionId)
      })
      const remaining = deadline - Date.now()
      if (decision.deliver || remaining <= 0) {
        return decision
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        edge,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining)
        })
      ])
      clearTimeout(timer)
    }
  } finally {
    dispose()
  }
}

/** What a chat was doing when it could not take the turn, in a terminal wait status's words. */
export function chatNotReadyStatus(
  decision: Extract<StructuredPointerDecision, { deliver: false }>
): string {
  switch (decision.retain) {
    case 'turn-unsettled':
      return 'running'
    case 'awaiting-human':
      return 'waiting for a person to answer a prompt'
    case 'session-not-attached':
      return 'session not attached'
    // Send verdicts: the gate itself never answers these.
    case 'dispatch-rejected':
    case 'dispatch-unknown':
      return decision.retain
  }
}
