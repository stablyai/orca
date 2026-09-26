import type {
  ClaudeAcquisitionAttempt,
  ClaudeAcquisitionRegistry,
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import { cancelClaudeAcquisitionAttempt } from './claude-structured-session-state'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPreSpawnError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import { retireClaudeDispatchWaiters } from './claude-structured-dispatch'
import { settledClaudeTurnEndLeaf } from './claude-structured-resume-point'

/** The root's own exit was seen first-hand. The lease follows the root, so a descendant
 *  left unverified or seen alive does not hold it. */
export function claudeRootExitObserved(
  connection: ClaudeStreamJsonConnection | null | undefined
): boolean {
  return connection?.exitVerdict.root === 'exited'
}

export function claudeAcquisitionCleanupError(
  connection: ClaudeStreamJsonConnection | null | undefined,
  cause: unknown
): Error {
  const verdict = connection?.exitVerdict
  if (verdict?.root === 'processless') {
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
    if (input.attempt.connection?.exitVerdict.root === 'processless') {
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
  onBackgroundTasksChanged?: (
    sessionId: string,
    state: AgentSessionBackgroundTaskState | null
  ) => void
}

async function finalizeClaudePublishedSession(
  input: CloseClaudePublishedSessionInput,
  session: ClaudeSession
): Promise<boolean> {
  retireClaudeDispatchWaiters(session)
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
  session.childWork.clear()
  if (session.backgroundTasks.clear()) {
    input.onBackgroundTasksChanged?.(input.sessionId, null)
  }
  const leafUuid = await settledClaudeTurnEndLeaf(session)
  const persistence =
    session.closePersistence ??
    (session.closePersistence = (async () => {
      await input.persistHandle?.({
        sessionId: input.sessionId,
        providerSessionId: session.providerSessionId,
        leafUuid,
        fence: session.fence
      })
    })())
  const ended = {
    type: 'ended',
    sessionId: input.sessionId,
    reason: 'claude session closed',
    observedAt: Date.now()
  } as const
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
  let persistenceError: unknown
  try {
    await persistence
    session.closeFinalized = true
    input.sessions.delete(input.sessionId)
    deliver({
      type: 'handle',
      sessionId: input.sessionId,
      providerSessionId: session.providerSessionId,
      leafUuid,
      fence: session.fence
    })
  } catch (error) {
    // Keep the closed session indexed so a retry can persist the same cursor.
    // Removing it first would turn a durable-write failure into a no-op retry.
    if (session.closePersistence === persistence) {
      session.closePersistence = undefined
    }
    persistenceError = error
  }
  // The connection already proved the child dead, so the session has ended
  // whatever the durable write did: withholding it would strand the renderer on
  // a session nothing re-drives. Emitted once, so a retry only re-persists.
  if (!session.closeEnded) {
    session.closeEnded = true
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
  if (persistenceError) {
    throw persistenceError
  }
  if (callbackThrew) {
    throw callbackError
  }
  if (rootExitVerdict) {
    throw rootExitVerdict
  }
  return true
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
    onBackgroundTasksChanged?: (
      sessionId: string,
      state: AgentSessionBackgroundTaskState | null
    ) => void
  }
): Promise<boolean> {
  return closeClaudePublishedSession({ sessions, sessionId, ...deps })
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
  onBackgroundTasksChanged?: (
    sessionId: string,
    state: AgentSessionBackgroundTaskState | null
  ) => void
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
