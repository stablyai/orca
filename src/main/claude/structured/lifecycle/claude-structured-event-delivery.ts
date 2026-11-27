import {
  claudeFrameSendFacts,
  recordClaudeDispatchReceipt
} from '../turns/claude-command-lifecycle'
import {
  resolveClaudeReplayTurn,
  withClaudeReplaySettlements,
  type ClaudeLateDispatchSettlement
} from '../turns/claude-replay-turn-resolution'
import type { StructuredAgentSessionTransitionSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-transition'
import type {
  ClaudeDispatchWaiter,
  ClaudeLateDispatchOutcome
} from '../claude-structured-session-state'
import { ClaudePluginInputError } from '../../sdk-transport/claude-plugin-ui'
import { claudePromptCardWritten } from '../../child-work/claude-child-work-evidence'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeSessionExit,
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from '../claude-structured-session-state'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-event'
import { claudeAuthRetryStatus } from '../journal/claude-assistant-failures'
import { cancelClaudeTurn } from '../turns/claude-structured-control-actions'
import { CLAUDE_STOP_GRACE_MS } from '../turns/claude-request-end-wait'

/** The turn each session last interrupted for a rejected credential, so one turn interrupts once. */
const authStoppedTurns = new WeakMap<ClaudeSession, string>()

/** Claude's blind retry loop on a credential its refresh couldn't fix (see claudeAuthRetryStatus) never clears. */
function stopClaudeAuthRetries(
  session: ClaudeSession,
  sessionId: string,
  { logger, onDispatchSettledLate }: ClaudeEventDelivery['deps']
): void {
  const turnId = session.translator?.currentTurnId
  // A command turn (e.g. compaction) reads its failure from Claude's own notice, so it keeps it.
  if (
    !turnId ||
    session.translator?.commandTurnId === turnId ||
    authStoppedTurns.get(session) === turnId
  ) {
    return
  }
  authStoppedTurns.set(session, turnId)
  void cancelClaudeTurn(
    session,
    CLAUDE_STOP_GRACE_MS,
    () => session.translator?.currentTurnId === turnId,
    (settlement) => onDispatchSettledLate?.({ sessionId, ...settlement })
  ).catch((error: unknown) =>
    logger?.warn('interrupting a Claude credential retry failed', {
      scope: 'claude-auth-retry-interrupt',
      error
    })
  )
}

type ClaudeEventDelivery = {
  session: ClaudeSession | null
  event: ClaudeStructuredSessionEvent
  deps: Pick<
    ClaudeStructuredSessionAdapterDeps,
    'onEvent' | 'onUserRenamed' | 'requestTimeoutMs' | 'logger' | 'onDispatchSettledLate'
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
  if (session && event.type === 'message' && claudeAuthRetryStatus(event.message) !== null) {
    stopClaudeAuthRetries(session, event.sessionId, deps)
  }
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
  message: Record<string, unknown>
  now: () => number
  deliver: (run: () => void) => void
  isCurrent: () => boolean
  onReceipt: StructuredAgentSessionTransitionSink['recordProviderReceipt']
  onSettledLate: ClaudeLateDispatchSettlement
  emit: (event: Extract<ClaudeStructuredSessionEvent, { type: 'message' }>) => void
}): void {
  const { session, sessionId, message } = input
  const settlements: ClaudeLateDispatchOutcome[] = []
  let receipt: { waiter: ClaudeDispatchWaiter; observedAt: number } | undefined
  const origin = session
    ? resolveClaudeReplayTurn(
        session,
        message,
        (settlement) => settlements.push(settlement),
        (waiter) => {
          receipt = { waiter, observedAt: input.now() }
        }
      )
    : null
  const startsTurn = origin !== null
  // Use host time for turn endpoints; provider timestamps may use a different clock.
  const observedAt = startsTurn || message.type === 'result' ? input.now() : undefined
  const requestedAt = origin?.requestedAt
  const sendFacts = claudeFrameSendFacts(session, message, startsTurn)
  // Publish the echoed turn before settling its send to avoid transient idle status.
  withClaudeReplaySettlements(
    session,
    settlements,
    () =>
      input.deliver(() => {
        if (receipt && session && input.isCurrent()) {
          recordClaudeDispatchReceipt(session, receipt.waiter, receipt.observedAt, input.onReceipt)
        }
        input.emit({
          type: 'message',
          sessionId,
          message,
          ...(startsTurn ? { startsTurn: true } : {}),
          ...(requestedAt == null ? {} : { requestedAt }),
          ...(origin?.clientMessageId ? { clientMessageId: origin.clientMessageId } : {}),
          ...sendFacts,
          ...(observedAt === undefined ? {} : { observedAt })
        })
      }),
    input.onSettledLate
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
