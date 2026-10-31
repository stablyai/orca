import type {
  ClaudeAcquisitionAttempt,
  ClaudeAcquisitionRegistry,
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionEvent
} from './structured/claude-structured-session-state'
import { cancelClaudeAcquisitionAttempt } from './structured/claude-structured-session-state'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
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

export {
  claudeRootExitObserved,
  claudeAcquisitionCleanupError,
  claudeCloseReport
} from './claude-structured-close-report'
import { claudeAcquisitionCleanupError, claudeCloseReport } from './claude-structured-close-report'

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
    input.attempt.cancelled = true
    for (const event of input.attempt.buffered.splice(0)) {
      event()
    }
    for (const prompt of input.prompts.clear()) {
      prompt.settle(null)
    }
    const closed = await input.attempt.connection?.closeOutcome()
    // close transfers any resolved SDK read before the translator releases its body state.
    if (closed?.receive.state !== 'retained') {
      input.translator?.flush()
    }
    if (closed?.receive.state !== 'retained') {
      input.attempt.dispose?.()
    }
    acquisitionError =
      claudeCloseReport(input.attempt.connection, closed, input.error) ?? input.error
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
  settledExitErrors?: Map<string, Error>
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
  const connectionClosed = await session.connection.closeOutcome()
  if (connectionClosed.receive.state !== 'retained') {
    session.unbindReadingControl?.()
  }
  const rootExitVerdict = claudeCloseReport(
    session.connection,
    connectionClosed,
    connectionClosed.receive.state === 'failed'
      ? connectionClosed.receive.error
      : new Error('provider close unproven')
  )
  if (rootExitVerdict instanceof AgentSessionAcquisitionExitUnprovenError) {
    if (connectionClosed.receive.state !== 'retained') {
      session.translator?.dispose()
    }
    return false
  }
  if (rootExitVerdict) {
    input.settledExitErrors?.set(input.sessionId, rootExitVerdict)
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
  await session.connection.startupSettled?.()
  if (!session.closeEnded) {
    session.closeEnded = true
    const observedAt = Date.now()
    session.events?.observeExit?.(undefined, observedAt)
    const ended: ClaudeStructuredSessionEvent = {
      type: 'ended',
      ...(session.connection.startupFailure
        ? {
            startupFailure: session.connection.startupFailure,
            failure: session.connection.startupFailure.failure
          }
        : {}),
      sessionId: input.sessionId,
      reason: 'claude session closed',
      cause: 'requested-close',
      ...(rootExitVerdict instanceof AgentSessionAcquisitionRootExitObservedError &&
      rootExitVerdict.deathEvidenceKind === 'kill-delivered'
        ? { deathEvidenceKind: 'kill-delivered' as const }
        : {}),
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
    throw callbackThrew
      ? claudeAcquisitionCleanupError(
          session.connection,
          new AggregateError([rootExitVerdict, callbackError], rootExitVerdict.message)
        )
      : rootExitVerdict
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
  if (!session || session.closeFinalized) {
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
  deps: Omit<CloseClaudePublishedSessionInput, 'sessions' | 'sessionId'>
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

export async function closeClaudeSession(
  input: CloseClaudePublishedSessionInput & {
    acquisitions: ClaudeAcquisitionRegistry
  }
): Promise<boolean> {
  const attempt = input.acquisitions.get(input.sessionId)
  const cancelled = await cancelClaudeAcquisitionAttempt(attempt)
  const report = claudeCloseReport(
    attempt?.connection,
    cancelled,
    cancelled?.receive.state === 'failed'
      ? cancelled.receive.error
      : new Error('acquisition cancel unproven')
  )
  if (report instanceof AgentSessionAcquisitionExitUnprovenError) {
    return false
  }
  if (attempt) {
    if (report && input.acquisitions.get(input.sessionId) === attempt) {
      input.settledExitErrors?.set(input.sessionId, report)
    }
    input.acquisitions.deleteIfCurrent(input.sessionId, attempt)
  }
  if (report) {
    throw report
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
