import type {
  ClaudeAcquisitionAttempt,
  ClaudeAcquisitionRegistry,
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import { cancelClaudeAcquisitionAttempt } from './claude-structured-session-state'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPreSpawnError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { closeProcessRegistry } from '@orca/process-host/close-process-registry'
import { retireClaudeDispatchWaiters } from './claude-structured-dispatch'
import { settledClaudeTurnEndLeaf } from './claude-structured-resume-point'
import { settleClaudeTurnEndWaiters } from './claude-request-end-wait'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

/** The root's own exit was seen first-hand. The lease follows the root, so a descendant
 *  left unverified or seen alive does not hold it. A failed spawn had no process to exit. */
export function claudeRootExitObserved(
  connection: ClaudeStreamJsonConnection | null | undefined
): boolean {
  const verdict = connection?.exitVerdict
  return verdict?.root === 'exited' && verdict.processless !== true
}

export function claudeAcquisitionCleanupError(
  connection: ClaudeStreamJsonConnection | null | undefined,
  cause: unknown
): Error {
  const verdict = connection?.exitVerdict
  if (verdict?.processless === true) {
    return new AgentSessionPreSpawnError(cause)
  }
  return claudeRootExitObserved(connection)
    ? new AgentSessionAcquisitionRootExitObservedError(cause)
    : new AgentSessionAcquisitionExitUnprovenError(cause)
}

export async function resolveClaudeAcquisitionError(input: {
  error: unknown
  sessionId: string
  sessions: Map<string, ClaudeSession>
  attempt: ClaudeAcquisitionAttempt
  translator: ClaudeJournalTranslator | null
  prompts: ClaudePromptRegistry
}): Promise<unknown> {
  let acquisitionError = input.error
  if (input.sessions.get(input.sessionId)?.connection !== input.attempt.connection) {
    input.translator?.dispose()
    for (const prompt of input.prompts.clear()) {
      prompt.settle(null)
    }
    const closed = (await input.attempt.connection?.close()) ?? true
    if (input.attempt.connection?.exitVerdict.processless === true) {
      acquisitionError = new AgentSessionPreSpawnError(input.error)
    } else if (!closed) {
      acquisitionError = claudeAcquisitionCleanupError(input.attempt.connection, input.error)
    }
  }
  return acquisitionError
}

export function settleClaudeExitedSession(session: ClaudeSession): void {
  // The child is gone, so no replay can start these turns. Nothing else ends a
  // waiter's life now that no deadline does.
  retireClaudeDispatchWaiters(session)
  settleClaudeTurnEndWaiters(session)
  for (const prompt of session.prompts.clear()) {
    prompt.settle(null)
  }
  session.translator?.dispose()
}

type CloseClaudePublishedSessionInput = {
  sessions: Map<string, ClaudeSession>
  sessionId: string
  persistHandle?: (handle: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
  logger?: StructuredAgentSessionLogger
}

async function finalizeClaudePublishedSession(
  input: CloseClaudePublishedSessionInput,
  session: ClaudeSession
): Promise<boolean> {
  retireClaudeDispatchWaiters(session)
  settleClaudeTurnEndWaiters(session)
  // Settle every in-flight permission callback so closing leaves no dangling promise; `null`
  // writes no response, and the SDK ignores any post-cleanup answer regardless.
  for (const prompt of session.prompts.clear()) {
    prompt.settle(null)
  }
  const connectionClosed = await session.connection.close()
  session.unbindReadingControl?.()
  let rootExitVerdict: Error | undefined
  if (connectionClosed !== true) {
    const cleanupError = claudeAcquisitionCleanupError(
      session.connection,
      new Error('provider close unproven')
    )
    // Only a genuinely unknown exit stays indexed for a retry. A proven root exit or processless
    // close is final — the owner releases the lease on it — so the session finalizes like a proven
    // close and still reports the verdict; kept indexed, it refused every later start of the chat.
    if (cleanupError instanceof AgentSessionAcquisitionExitUnprovenError) {
      return false
    }
    rootExitVerdict = cleanupError
  }
  // Queues the session's ending for the host's child records; the adapter delivers it after close.
  // A proven close stopped what still ran: on POSIX the whole tree was seen gone; on Windows Claude
  // left after its stdin ended, or taskkill reported its tree terminated. Any other end, like an
  // exit of the session's own, leaves how it ended unknown.
  if (connectionClosed === true) {
    session.childWork.stopLive()
  }
  session.childWork.clear()
  session.backgroundTasks.clear()
  // The exit is proven, so the session ends now. Saving its resume point is bookkeeping that
  // follows, reported on failure; it never holds the close or reads as an unproven exit.
  session.closeFinalized = true
  input.sessions.delete(input.sessionId)
  let callbackError: unknown
  let callbackThrew = false
  const deliver = (event: ClaudeStructuredSessionEvent): void => {
    try {
      input.onEvent?.(event)
    } catch (error) {
      callbackThrew = true
      callbackError ??= error
    }
  }
  if (!session.closeEnded) {
    session.closeEnded = true
    const ended: ClaudeStructuredSessionEvent = {
      type: 'ended',
      sessionId: input.sessionId,
      reason: 'claude session closed',
      // The host ends the child's record on it, whoever was still waiting on the close.
      cause: 'requested-close',
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration,
      observedAt: Date.now(),
      ...(session.startup.answered ? {} : { startupUnanswered: true as const })
    }
    try {
      try {
        session.translator?.handle(ended)
      } catch (error) {
        callbackThrew = true
        callbackError ??= error
      }
      deliver(ended)
    } finally {
      session.translator?.dispose()
    }
  }
  session.closePersistence ??= persistClosedClaudeSession(input, session)
  if (rootExitVerdict) {
    throw rootExitVerdict
  }
  if (callbackThrew) {
    // The exit is proven; only what followed it failed, which the caller reports.
    throw new AgentSessionAcquisitionExitProvenError(callbackError)
  }
  return true
}

/** The resume point a closed session leaves for the next start, after the close already ended. */
async function persistClosedClaudeSession(
  input: CloseClaudePublishedSessionInput,
  session: ClaudeSession
): Promise<void> {
  try {
    const leafUuid = await settledClaudeTurnEndLeaf(session)
    const handle = {
      sessionId: input.sessionId,
      providerSessionId: session.providerSessionId,
      leafUuid,
      fence: session.fence
    }
    await input.persistHandle?.(handle)
    input.onEvent?.({ type: 'handle', ...handle })
  } catch (error) {
    input.logger?.warn("saving a closed Claude session's resume point failed", {
      scope: 'claude-close-resume-point',
      sessionId: input.sessionId,
      error
    })
  }
}

export async function closeClaudePublishedSession(
  input: CloseClaudePublishedSessionInput
): Promise<boolean> {
  const session = input.sessions.get(input.sessionId)
  if (!session) {
    return true
  }
  if (session.closeFinalized) {
    return true
  }
  if (session.closeFinalization) {
    return session.closeFinalization
  }
  const finalization = finalizeClaudePublishedSession(input, session)
  session.closeFinalization = finalization
  try {
    return await finalization
  } finally {
    if (session.closeFinalization === finalization && !session.closeFinalized) {
      session.closeFinalization = undefined
    }
  }
}

export function closeClaudePublishedSessionForDeps(
  sessions: Map<string, ClaudeSession>,
  sessionId: string,
  deps: {
    persistHandle?: (handle: {
      sessionId: string
      providerSessionId: string
      leafUuid: string | null
      fence: number
    }) => Promise<void>
    onEvent?: (event: ClaudeStructuredSessionEvent) => void
    logger?: StructuredAgentSessionLogger
  }
): Promise<boolean> {
  return closeClaudePublishedSession({ sessions, sessionId, ...deps })
}

/** The root exited after a close came back unproven: joins a close still running, or finishes that
 *  one for this exact child, through `afterClose`, which publishes the session's child work like
 *  any close. What failed after the exit is reported. */
export function finishClaudeCloseAfterExit(input: {
  sessions: Map<string, ClaudeSession>
  sessionId: string
  connection: ClaudeStreamJsonConnection | null
  deps: Parameters<typeof closeClaudePublishedSessionForDeps>[2]
  afterClose: (close: () => Promise<boolean>) => Promise<boolean>
}): void {
  const { sessions, sessionId, deps } = input
  if (sessions.get(sessionId)?.connection !== input.connection) {
    return
  }
  void input
    .afterClose(() => closeClaudePublishedSessionForDeps(sessions, sessionId, deps))
    .catch((error: unknown) =>
      deps.logger?.warn('finishing a Claude close after its process exited reported', {
        scope: 'claude-close-after-exit',
        sessionId,
        error
      })
    )
}

export async function closeClaudeSession(input: {
  sessionId: string
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  persistHandle?: (handle: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
  logger?: StructuredAgentSessionLogger
}): Promise<boolean> {
  const attempt = input.acquisitions.get(input.sessionId)
  if (!(await cancelClaudeAcquisitionAttempt(attempt))) {
    const cleanupError = claudeAcquisitionCleanupError(
      attempt?.connection,
      new Error('acquisition cancel unproven')
    )
    // Why: cancellation must preserve the same actionable verdict as published-session close.
    if (!(cleanupError instanceof AgentSessionAcquisitionExitUnprovenError)) {
      throw cleanupError
    }
    return false
  }
  if (attempt) {
    input.acquisitions.deleteIfCurrent(input.sessionId, attempt)
  }
  return closeClaudePublishedSession(input)
}

export async function closeAllClaudeSessions(input: {
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  exits: Map<string, ClaudeSessionExit>
  closeSession: (sessionId: string) => Promise<boolean>
  closeExit: (sessionId: string) => Promise<boolean>
}): Promise<void> {
  input.acquisitions.close()
  await closeProcessRegistry({
    attempts: 3,
    hasEntries: () =>
      input.sessions.size > 0 || input.acquisitions.size > 0 || input.exits.size > 0,
    entryIds: () =>
      new Set([
        ...input.sessions.keys(),
        ...input.acquisitions.sessionIds(),
        ...input.exits.keys()
      ]),
    closeEntry: async (sessionId) =>
      input.exits.has(sessionId) ? input.closeExit(sessionId) : input.closeSession(sessionId),
    failureMessage: 'claude structured session shutdown could not prove every child stopped'
  })
}
