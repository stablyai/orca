import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'
import {
  recordStructuredAgentSessionDeliveryFailure,
  type startThatFailedWhileQueued
} from '../startup/structured-agent-session-start-failure-row'
import type { StructuredAgentSessionStartClaim } from '../startup/structured-agent-session-agent-start'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

type StartFailure = NonNullable<Awaited<ReturnType<typeof startThatFailedWhileQueued>>>

export function observeDeliveryStart(
  start: StructuredAgentSessionStartClaim,
  sessionId: string,
  logger: StructuredAgentSessionLogger
): Promise<boolean> {
  return start.outcome.then(
    () => true,
    (error: unknown) => {
      logger.warn('waiting for an agent start failed', {
        scope: 'delivery-loop-start',
        sessionId,
        error
      })
      return false
    }
  )
}

export async function failStructuredDelivery(
  deps: StructuredAgentSessionDeliveryLoopDeps,
  sessionId: string,
  failure: StartFailure,
  clientMessageId: string | null
): Promise<'continue'> {
  const session = deps.sessions.get(sessionId)
  if (session) {
    await recordStructuredAgentSessionDeliveryFailure(
      { journal: session.journal, fence: deps.conversationFence(sessionId) },
      failure,
      await deps.failureTextContext(sessionId),
      clientMessageId
    )
    if (clientMessageId) {
      await deps.settleProviderSwitch?.(session, clientMessageId, 'failed')
    }
  }
  return 'continue'
}
