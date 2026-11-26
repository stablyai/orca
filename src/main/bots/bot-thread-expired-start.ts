import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { closeStructuredAgentSessionChild } from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/** A delivery can run out of time while its fresh background chat commits. */
export async function forgetExpiredBotThread(
  runtime: OrcaRuntimeService,
  sessionId: string
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getConversation(sessionId)
  if (!host || !record?.neverStarted) {
    return
  }
  const { store } = host.deps
  const unused = () => {
    const current = store.getConversation(sessionId)
    return (
      current?.createdAt === record.createdAt &&
      current.neverStarted &&
      !host.isSessionTabVisible(sessionId) &&
      store.admittedSendCount(sessionId) === 0
    )
  }
  if (!unused()) {
    return
  }
  try {
    const closed = await closeStructuredAgentSessionChild(sessionId, {
      runtime,
      admitClose: (work) => work.sessionId === sessionId && work.state === 'idle' && unused()
    })
    if (closed.stopped) {
      await host.serialize(sessionId, async () => {
        if (!host.hasSession(sessionId) && unused()) {
          await store.forgetIdleChat(
            { sessionId, location: record.location, idleBefore: record.createdAt },
            async () => unused() && !host.hasSession(sessionId)
          )
        }
      })
    }
  } catch (error) {
    host.deps.logger.warn('retiring an unused connector chat failed', {
      scope: 'connector-start-expiry',
      sessionId,
      error
    })
  }
}
