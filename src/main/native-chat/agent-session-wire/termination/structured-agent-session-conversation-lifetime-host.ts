import { hostStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-host-current-work'
import { stopStructuredAgentSessionAgentUnderSerialize } from './structured-agent-session-host-lifetime'
import {
  sameProviderChild,
  structuredAgentSessionConversationFence
} from '../host/structured-agent-session-provider-child'
import { closeStructuredAgentSessionHandovers } from '../delivery/structured-agent-session-handing-over'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionConversations } from '../host/structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from '../host/structured-agent-session-host-types'

export type StructuredAgentSessionConversationLifetimeHost = {
  /** Resolve lazily because host collaborators are assigned after construction. */
  context: () => StructuredAgentSessionLifetimeContext
  sessions: StructuredAgentSessionConversations
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Caller already holds session serialization. */
  open: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  deliveryActive: (sessionId: string) => boolean
  /** Retain status rows while a tab still lists the chat. */
  closeStatus: (sessionId: string, options: { listed: boolean }) => void
  childWorkOpen: (sessionId: string) => boolean
}

export function createStructuredAgentSessionStopStartingChild(
  host: StructuredAgentSessionConversationLifetimeHost
) {
  return (sessionId: string, expired: StructuredAgentSessionProviderChildIdentity | null): void => {
    void host
      .serialize(sessionId, async () => {
        const child = host.sessions.get(sessionId)?.child
        if (
          !expired ||
          !child ||
          child.phase !== 'starting' ||
          !sameProviderChild(child, expired)
        ) {
          return
        }
        await stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, {
          cause: 'host-stop'
        })
      })
      .catch((error: unknown) =>
        host.context().deps.logger.warn('stopping an agent that could not finish starting failed', {
          scope: 'startup-limit',
          sessionId,
          error
        })
      )
  }
}

/** Cut a closing chat's handovers and start, outside serialization so hung work cannot block the close.
 *  A close that must be admitted runs this in the session lane instead, and throws if refused. */
export function cutClosingStructuredAgentSession(
  host: StructuredAgentSessionConversationLifetimeHost,
  sessionId: string,
  admit?: () => boolean
): void {
  if (admit && !admit()) {
    throw new Error('The user kept this chat open.')
  }
  const journal = host.sessions.get(sessionId)?.journal
  if (journal) {
    closeStructuredAgentSessionHandovers(journal)
  }
  const { deps, runtimeState } = host.context()
  if (deps.store.selectWritableRecord(sessionId).kind !== 'unreadable') {
    runtimeState.acquireAborts.abort(sessionId, 'closed while starting')
  }
}

/** Caller owns the session lane; a dormant question is a personal close target without a child. */
export async function closeDormantStructuredAttention(
  host: StructuredAgentSessionConversationLifetimeHost,
  sessionId: string
): Promise<void> {
  const { deps } = host.context()
  const session =
    host.sessions.get(sessionId) ??
    (deps.store.getConversation(sessionId)?.lastTurn?.state === 'open'
      ? await host.open(sessionId)
      : null)
  if (
    session &&
    !session.child &&
    (host.context().hasUnacceptedRecovery?.(sessionId) ||
      hostStructuredAgentSessionCurrentWork(
        { store: deps.store, sessions: host.sessions },
        sessionId
      )?.attentionPrompts().length)
  ) {
    await session.journal.appendStopEvent(
      { reason: 'user-close' },
      structuredAgentSessionConversationFence(deps.store, sessionId)
    )
  }
}
