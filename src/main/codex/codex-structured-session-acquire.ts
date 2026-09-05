import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  closeFailedCodexAcquisition,
  stopSupersededCodexAcquisition
} from './codex-structured-acquisition-lifecycle'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { codexProcessIdentity, codexProviderHandleLink } from './codex-structured-owner-identity'
import { buildCodexStructuredChildEnvironment } from './codex-structured-child-environment'
import { openCodexThread } from './codex-structured-thread-open'
import {
  closeCodexPublishedSession,
  handleCodexSessionExit
} from './codex-structured-session-close'
import {
  reportedCodexThreadOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import {
  codexSessionLifecycle,
  mintCodexAcquisitionGeneration,
  type CodexAcquisitionRegistry,
  type CodexAcquisitionAttempt,
  type CodexSession,
  type CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'
import type { CodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type { deliverCodexServerRequest } from './codex-structured-provider-events'

export async function acquireCodexStructuredSession(input: {
  input: StructuredAgentSessionAcquireInput
  deps: CodexStructuredSessionAdapterDeps
  sessions: Map<string, CodexSession>
  acquisitions: CodexAcquisitionRegistry
  turnCancellation: CodexStructuredTurnCancellation
  notificationRetries: CodexStructuredNotificationRetry
  deliver: (
    acquisition: CodexAcquisitionAttempt['window'],
    sessionId: string,
    event: () => unknown,
    retainedBytes?: number
  ) => void
  handleServerRequest: (
    sessionId: string,
    request: Parameters<typeof deliverCodexServerRequest>[2]
  ) => void
  handleUnhandledFrame: (sessionId: string, kind: string, payload: unknown) => void
  forceCloseUnexpected: (
    sessionId: string,
    fence: number,
    acquisitionGeneration: string,
    reason: Error
  ) => Promise<boolean>
}): Promise<AgentSessionAcquisition> {
  const {
    input: acquireInput,
    deps,
    sessions,
    acquisitions,
    turnCancellation,
    notificationRetries
  } = input
  const sessionId = acquireInput.identity.sessionId
  const { previousAttempt, attempt } = acquisitions.start(sessionId)
  const acquisition = attempt.window
  let unbindReadingControl: (() => void) | undefined
  let primaryThreadId =
    acquireInput.identity.providerHandle.kind === 'codex'
      ? acquireInput.identity.providerHandle.threadId
      : null
  const translator = acquireInput.events
    ? createCodexJournalTranslator({
        sink: acquireInput.events,
        primaryThreadId: () => primaryThreadId,
        bindPromptItemId: (journalItemId, threadId, promptKey) =>
          acquisition.prompts.bindJournalItemId(journalItemId, threadId, promptKey)
      })
    : null
  const open = deps.openConnection ?? openCodexAppServerConnection
  try {
    await stopSupersededCodexAcquisition({
      sessionId,
      registry: acquisitions,
      replacement: attempt,
      previous: previousAttempt
    })
    acquisitions.assertCurrent(sessionId, attempt)
    if (!(await closeCodexPublishedSession(sessions, sessionId, deps.onEvent))) {
      throw new Error(`codex app-server for session ${sessionId} could not be stopped`)
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const launch = await deps
      .resolveLaunch({ identity: acquireInput.identity })
      .catch((error: unknown) => {
        throw new AgentSessionPreSpawnError(error)
      })
    acquisitions.assertCurrent(sessionId, attempt)
    const connection = await open(
      {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: buildCodexStructuredChildEnvironment(launch, acquireInput.spawnToken)
      },
      {
        onNotification: (method, params) =>
          input.deliver(
            acquisition,
            sessionId,
            () => notificationRetries.handle(sessionId, method, params),
            Buffer.byteLength(JSON.stringify(params ?? null), 'utf8')
          ),
        onServerRequest: (request) =>
          input.deliver(
            acquisition,
            sessionId,
            () => input.handleServerRequest(sessionId, request),
            Buffer.byteLength(JSON.stringify(request), 'utf8')
          ),
        onUnhandledFrame: (kind, payload) =>
          input.deliver(
            acquisition,
            sessionId,
            () => input.handleUnhandledFrame(sessionId, kind, payload),
            Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8')
          ),
        onExit: (error) => {
          try {
            handleCodexSessionExit({
              sessions,
              sessionId,
              connection: acquisition.connection,
              error,
              prompts: acquisition.prompts,
              ...(deps.onEvent ? { onEvent: deps.onEvent } : {})
            })
          } finally {
            notificationRetries.clear(sessionId, acquisition.connection)
          }
        }
      }
    )
    acquisition.connection = connection
    if (connection.pauseReading && connection.resumeReading) {
      unbindReadingControl = acquireInput.events?.bindReadingControl?.({
        pauseReading: connection.pauseReading,
        resumeReading: () => {
          connection.resumeReading?.()
          notificationRetries.retry(sessionId, connection)
        }
      })
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const opened = await openCodexThread(connection, launch, deps.requestTimeoutMs)
    acquisitions.assertCurrent(sessionId, attempt)
    primaryThreadId = opened.threadId
    const restoreAdmission = translator?.restoreThread(opened.threadId, opened.thread ?? {})
    if (restoreAdmission && !restoreAdmission.accepted) {
      throw new AgentSessionAcquisitionRefusal(
        'Codex thread history exceeds the bounded restore queue; history was not partially imported.'
      )
    }
    const process = await codexProcessIdentity(
      { ...acquireInput, pid: connection.pid },
      deps.readProcessStartTime
    )
    acquisitions.assertCurrent(sessionId, attempt)
    const acquired: AgentSessionAcquisition = {
      process,
      link: codexProviderHandleLink({
        threadId: opened.threadId,
        resumed: launch.resumeThreadId !== null,
        fence: acquireInput.fence,
        linkId: deps.mintLinkId?.(),
        observedAt: deps.now?.() ?? Date.now()
      }),
      acquisitionGeneration: mintCodexAcquisitionGeneration(deps)
    }
    if (connection.closed) {
      throw new Error(`codex app-server for session ${sessionId} exited while being acquired`)
    }
    acquisitions.assertCurrent(sessionId, attempt)
    acquisitions.deleteIfCurrent(sessionId, attempt)
    const session: CodexSession = {
      connection,
      ...codexSessionLifecycle(acquireInput.fence, acquired.acquisitionGeneration as string),
      threadId: opened.threadId,
      historyPath: opened.historyPath,
      prompts: acquisition.prompts,
      options: restoredCodexSessionOptions(acquireInput.options),
      reportedOptions: reportedCodexThreadOptions(opened),
      turnIdWaiters: [],
      translator,
      forceCloseUnexpected: (reason) =>
        input.forceCloseUnexpected(
          sessionId,
          acquireInput.fence,
          acquired.acquisitionGeneration as string,
          reason
        ),
      ...(unbindReadingControl ? { unbindReadingControl } : {})
    }
    turnCancellation.register(session)
    sessions.set(sessionId, session)
    for (const event of acquisition.drain()) {
      event()
    }
    return acquired
  } catch (error) {
    if (sessions.get(sessionId)?.connection !== acquisition.connection) {
      return closeFailedCodexAcquisition({
        sessionId,
        registry: acquisitions,
        attempt,
        cause: error,
        dispose: () => {
          unbindReadingControl?.()
          translator?.dispose()
        }
      })
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    throw error
  } finally {
    attempt.finish()
  }
}
