import { claudeFrameSendFacts } from '../turns/claude-command-lifecycle'
import {
  resolveClaudeReplayTurn,
  withClaudeReplaySettlements
} from '../turns/claude-replay-turn-resolution'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { ClaudePluginInputError } from '../../sdk-transport/claude-plugin-ui'
import { claudePromptCardWritten } from '../../child-work/claude-child-work-evidence'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeSessionExit,
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from '../claude-structured-session-state'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-event'

type ClaudeEventDelivery = {
  session: ClaudeSession | null
  event: ClaudeStructuredSessionEvent
  deps: Pick<
    ClaudeStructuredSessionAdapterDeps,
    'onEvent' | 'onUserRenamed' | 'requestTimeoutMs' | 'logger'
  >
  publishChildWork: (
    sessionId: string,
    session?: ClaudeSession | null,
    message?: Record<string, unknown> | null
  ) => void
}

export function emitClaudeStructuredSessionEvent({
  session,
  event,
  deps,
  publishChildWork
}: ClaudeEventDelivery): void {
  if (event.type === 'retiring') {
    // Retire host input before publishing the logical failure to subscribers.
    deps.onEvent?.(event)
  }
  if (event.type === 'ended' || event.type === 'retiring') {
    session?.delivery.dispose()
    session?.childWork.clear()
    session?.backgroundTasks.clear()
  } else if (event.type === 'message') {
    session?.childWork.observe(event.message, session.translator?.childToolOwner)
    session?.backgroundTasks.observe(event.message, event.startsTurn === true)
  } else if (event.type === 'prompt-cancelled') {
    // Clear waiting before journaling cancellation so status cannot wait on a closed card.
    publishChildWork(event.sessionId, session)
  }
  if (event.type === 'message' && session?.commands.observe(event.message)) {
    session.events?.publish()
  }
  session?.translator?.handle(event)
  if (event.type !== 'retiring') {
    deps.onEvent?.(event)
  }
  if (event.type === 'message' && event.renamedTo) {
    deps.onUserRenamed?.(event.sessionId, event.renamedTo)
  }
  publishChildWork(event.sessionId, session, event.type === 'message' ? event.message : null)
  // Child waiting requires the card to be durable.
  void claudePromptCardWritten(session, event)?.then(() => publishChildWork(event.sessionId))
}

export function deliverClaudeReplayFrame(input: {
  session: ClaudeSession | null
  sessionId: string
  current: boolean
  message: Record<string, unknown>
  observedAt: number | undefined
  onReceived: StructuredAgentSessionEventSink['recordProviderReceipt']
  onSettledLate: ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']
  emit: (event: Extract<ClaudeStructuredSessionEvent, { type: 'message' }>) => void
}): void {
  const { session, sessionId, message, observedAt } = input
  const settlements: Parameters<typeof withClaudeReplaySettlements>[1] = []
  const origin = session
    ? resolveClaudeReplayTurn(
        session,
        message,
        (settlement) => settlements.push(settlement),
        input.current && observedAt !== undefined
          ? { observedAt, onReceived: (receipt) => input.onReceived?.(receipt) }
          : undefined
      )
    : null
  const startsTurn = origin !== null
  const requestedAt = origin?.requestedAt
  const sendFacts = claudeFrameSendFacts(session, message, startsTurn)
  // Publish the frame before settling echoed delivery, so the host never sees transient idle.
  withClaudeReplaySettlements(
    session,
    settlements,
    () => {
      input.emit({
        type: 'message',
        sessionId,
        message,
        ...(startsTurn ? { startsTurn: true } : {}),
        ...(requestedAt == null ? {} : { requestedAt }),
        ...(origin?.clientMessageId ? { clientMessageId: origin.clientMessageId } : {}),
        ...(origin?.queuedDispatch ? { queuedDispatch: origin.queuedDispatch } : {}),
        ...sendFacts,
        ...(observedAt === undefined ? {} : { observedAt })
      })
    },
    (settlement) => input.onSettledLate?.({ sessionId, ...settlement })
  )
}

export function deliverClaudeConnectionEvent(
  sessions: ReadonlyMap<string, ClaudeSession>,
  exits: ReadonlyMap<string, ClaudeSessionExit>,
  attempt: ClaudeAcquisitionAttempt,
  sessionId: string,
  event: () => void,
  payload?: unknown
): void {
  attempt.delivery.deliver(() => {
    if (attempt.cancelled || exits.get(sessionId)?.error instanceof ClaudePluginInputError) {
      return
    }
    if (
      sessions.get(sessionId)?.connection === attempt.connection ||
      exits.get(sessionId)?.connection === attempt.connection
    ) {
      event()
    }
  }, payload)
}
