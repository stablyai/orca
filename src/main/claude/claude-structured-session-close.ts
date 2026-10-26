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
import { claudeHeldSends } from './claude-command-lifecycle'
import { settledClaudeTurnEndLeaf } from './claude-structured-resume-point'
import { settleClaudeTurnEndWaiters } from './claude-request-end-wait'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

/** Root exit releases the lease even with unverified descendants; a failed spawn proves no exit. */
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

/** Retain unproven acquisitions so a later Stop can retry cleanup. */
export async function resolveClaudeAcquisitionError(input: {
  error: unknown
  sessionId: string
  sessions: Map<string, ClaudeSession>
  attempt: ClaudeAcquisitionAttempt
  translator: ClaudeJournalTranslator | null
  prompts: ClaudePromptRegistry
  releaseAcquisition: () => void
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
  if (!(acquisitionError instanceof AgentSessionAcquisitionExitUnprovenError)) {
    input.releaseAcquisition()
  }
  return acquisitionError
}

export function settleClaudeExitedSession(session: ClaudeSession): void {
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
  settleClaudeTurnEndWaiters(session)
  // Null settles callbacks without writing responses during SDK cleanup.
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
    // Retain only unknown exits for retry; final verdicts release ownership and permit restart.
    if (cleanupError instanceof AgentSessionAcquisitionExitUnprovenError) {
      return false
    }
    rootExitVerdict = cleanupError
  }
  // Retain held sends through close until the host receives the exit report.
  session.events?.observeExit?.(claudeHeldSends(session))
  retireClaudeDispatchWaiters(session)
  // Closing the session does not prove an outcome for unfinished child work.
  session.childWork.clear()
  session.backgroundTasks.clear()
  // Finalize before saving the resume point; persistence failure cannot undo a proven exit.
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
    const observedAt = Date.now()
    session.events?.observeExit?.(undefined, observedAt)
    const ended: ClaudeStructuredSessionEvent = {
      type: 'ended',
      sessionId: input.sessionId,
      reason: 'claude session closed',
      cause: 'requested-close',
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration,
      observedAt
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
    throw new AgentSessionAcquisitionExitProvenError(callbackError)
  }
  return true
}

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

/** Complete the pending close for this exact connection after observing its root exit. */
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
    if (!(cleanupError instanceof AgentSessionAcquisitionExitUnprovenError)) {
      // Release dead attempts so they cannot block the next start.
      if (attempt) {
        input.acquisitions.deleteIfCurrent(input.sessionId, attempt)
      }
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
