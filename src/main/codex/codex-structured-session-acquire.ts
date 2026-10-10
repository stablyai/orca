import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import {
  CODEX_STRUCTURED_HANDLE_NAMESPACE,
  isAgentSessionProviderHandleInNamespace
} from '../../shared/agent-session-provider-handle-encoding'
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
import { CodexBackgroundTaskTracker, codexChildWorkSink } from './codex-background-task-tracker'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexSessionJournalTranslator } from './codex-structured-session-journal'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import {
  codexProviderHandleLink,
  codexSpawnedProcessIdentity
} from './codex-structured-owner-identity'
import { codexStructuredChildEnvironment } from './codex-structured-child-environment'
import { openCodexThread } from './codex-structured-thread-open'
import { withCodexVisualsThreadConfig } from './codex-structured-visuals'
import {
  closeCodexPublishedSession,
  handleCodexSessionExit
} from './codex-structured-session-close'
import { restoredCodexSessionOptions } from './codex-structured-session-options'
import { startBackgroundCodexCatalogRefresh } from './codex-structured-background-catalog'
import {
  codexAcquireCatalogAccess,
  codexAcquireFastModeCatalog
} from './codex-structured-acquire-catalog'
import {
  reconcileCodexFastModeOption,
  reportedCodexThreadOptions
} from './codex-structured-fast-mode'
import {
  assertCodexConnectionOpen,
  codexSessionLifecycle,
  mintCodexAcquisitionGeneration,
  type CodexAcquisitionRegistry,
  type CodexAcquisitionAttempt,
  type CodexSession,
  type CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'
import type { CodexStructuredSessionTeardown } from './codex-structured-session-teardown'
import type { CodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type { deliverCodexServerRequest } from './codex-structured-provider-events'
import { codexAcquisitionNotificationHandler } from './codex-structured-acquisition-notification'

export async function acquireCodexStructuredSession(input: {
  input: StructuredAgentSessionAcquireInput
  deps: CodexStructuredSessionAdapterDeps
  sessions: Map<string, CodexSession>
  acquisitions: CodexAcquisitionRegistry
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
  forceCloseUnexpected: CodexStructuredSessionTeardown['forceCloseUnexpected']
}): Promise<AgentSessionAcquisition> {
  const { input: acquireInput, deps, sessions, acquisitions, notificationRetries } = input
  const sessionId = acquireInput.identity.sessionId
  const { previousAttempt, attempt } = acquisitions.start(sessionId)
  const acquisition = attempt.window
  let unbindReadingControl: (() => void) | undefined
  const provenHandle = acquireInput.identity.providerHandle
  let primaryThreadId =
    provenHandle &&
    isAgentSessionProviderHandleInNamespace(provenHandle, CODEX_STRUCTURED_HANDLE_NAMESPACE)
      ? provenHandle.nativeId
      : null
  const subagentExecutions = new CodexSubagentExecutions()
  const dispatchEchoes = createCodexDispatchEchoes()
  let account: AgentSessionAccountKind | undefined
  // Minted before the translator, which names this connection's frame rows with it.
  const acquisitionGeneration = mintCodexAcquisitionGeneration(deps)
  const translator = createCodexSessionJournalTranslator({
    sink: acquireInput.events,
    account: () => account,
    sessionId,
    acquisitionId: acquisitionGeneration,
    deps,
    primaryThreadId: () => primaryThreadId,
    dispatchEchoes,
    subagentExecutions,
    prompts: acquisition.prompts
  })
  const open = deps.openConnection ?? openCodexAppServerConnection
  const spawnIdentity = codexSpawnedProcessIdentity(acquireInput, deps.readProcessStartTime)
  try {
    await stopSupersededCodexAcquisition({
      sessionId,
      registry: acquisitions,
      replacement: attempt,
      previous: previousAttempt
    })
    acquisitions.assertCurrent(sessionId, attempt)
    if (
      !(await closeCodexPublishedSession(
        sessions,
        sessionId,
        deps.onEvent,
        deps.logger ? { logger: deps.logger } : {}
      ))
    ) {
      throw new Error(`codex app-server for session ${sessionId} could not be stopped`)
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const launch = await deps
      .resolveLaunch({ identity: acquireInput.identity })
      .catch((error: unknown) => {
        throw new AgentSessionPreSpawnError(error)
      })
    acquisitions.assertCurrent(sessionId, attempt)
    account = launch.codexHome ? deps.resolveAccountKind?.(launch.codexHome) : undefined
    const connection = await open(
      {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        ...codexStructuredChildEnvironment(launch, acquireInput.spawnToken, sessionId)
      },
      {
        onNotification: codexAcquisitionNotificationHandler({
          acquisition,
          sessionId,
          dispatchEchoes,
          notificationRetries,
          deliver: input.deliver,
          now: deps.now ?? Date.now
        }),
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
        onSpawned: spawnIdentity.onSpawned,
        ...(acquireInput.onOutput ? { onOutput: acquireInput.onOutput } : {}),
        onExit: (error, exit) => {
          try {
            handleCodexSessionExit({
              sessions,
              sessionId,
              connection: acquisition.connection,
              error,
              // The end of a close Orca began, even one that came back unproven before it.
              ...(exit?.expected ? { closedByOrca: true as const } : {}),
              ...(deps.logger ? { logger: deps.logger } : {}),
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
    const threadLaunch = await withCodexVisualsThreadConfig(connection, launch, {
      sessionId,
      ...(deps.logger ? { logger: deps.logger } : {})
    })
    acquisitions.assertCurrent(sessionId, attempt)
    const opened = await openCodexThread(connection, threadLaunch, deps.requestTimeoutMs)
    acquisitions.assertCurrent(sessionId, attempt)
    primaryThreadId = opened.threadId
    const restoreAdmission = translator?.restoreThread(opened.threadId, opened.thread ?? {})
    if (restoreAdmission && !restoreAdmission.accepted) {
      throw AgentSessionAcquisitionRefusal.historyTooLarge(
        'Codex thread history exceeds the bounded restore queue; history was not partially imported.'
      )
    }
    const process = await spawnIdentity.read(connection.pid)
    acquisitions.assertCurrent(sessionId, attempt)
    const acquired: AgentSessionAcquisition = {
      process,
      link: codexProviderHandleLink({
        threadId: opened.threadId,
        ...(opened.supersededThreadId
          ? { resumed: false, supersedesThreadId: opened.supersededThreadId }
          : { resumed: launch.resumeThreadId !== null }),
        fence: acquireInput.fence,
        linkId: deps.mintLinkId?.(),
        observedAt: deps.now?.() ?? Date.now()
      }),
      acquisitionGeneration
    }
    assertCodexConnectionOpen(connection, sessionId)
    acquisitions.assertCurrent(sessionId, attempt)
    const options = restoredCodexSessionOptions(acquireInput.options)
    const catalogAccess = codexAcquireCatalogAccess(deps, launch)
    const fastModeCatalog = codexAcquireFastModeCatalog({
      catalogAccess,
      opened,
      restoreNeedsCatalog: options.get('fastMode') === 'true' || options.has('serviceTier')
    })
    acquisitions.assertCurrent(sessionId, attempt)
    assertCodexConnectionOpen(connection, sessionId)
    acquisitions.deleteIfCurrent(sessionId, attempt)
    // Where this session's child work goes: the host's records, after each frame is journaled.
    const sink = codexChildWorkSink(sessionId, deps)
    const session: CodexSession = {
      account,
      connection,
      ...codexSessionLifecycle(acquireInput.fence, acquired.acquisitionGeneration as string),
      threadId: opened.threadId,
      historyMode: opened.historyMode,
      activeTurnIds: new Set(),
      abortedTurnIds: new Set(),
      prompts: acquisition.prompts,
      options,
      reportedOptions: reportedCodexThreadOptions(opened),
      ...(catalogAccess ? { catalogAccess } : {}),
      dispatchEchoes,
      translator,
      backgroundTasks: new CodexBackgroundTaskTracker(opened.threadId, subagentExecutions, sink),
      forceCloseUnexpected: (reason) =>
        input.forceCloseUnexpected(
          sessionId,
          acquireInput.fence,
          acquired.acquisitionGeneration as string,
          reason
        ),
      ...(unbindReadingControl ? { unbindReadingControl } : {})
    }
    if (fastModeCatalog) {
      // The model the next turn sends, as turn/start and the background refresh resolve it.
      const model = options.get('model') ?? opened.model ?? fastModeCatalog.result.current.model
      reconcileCodexFastModeOption(session, {
        fastModeTierByModel: fastModeCatalog.fastModeTierByModel,
        currentFastMode: true,
        model,
        modelFastModeSupport: fastModeCatalog.result.models.find((entry) => entry.id === model)
          ?.supportsFastMode
      })
    }
    sessions.set(sessionId, session)
    for (const event of acquisition.drain()) {
      event()
    }
    startBackgroundCodexCatalogRefresh({
      session,
      sessionId,
      sessions,
      timeoutMs: deps.requestTimeoutMs,
      logger: deps.logger
    })
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
