import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import {
  CODEX_STRUCTURED_HANDLE_NAMESPACE,
  isAgentSessionProviderHandleInNamespace
} from '../../shared/agent-session-provider-handle-encoding'
import {
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  closeFailedCodexAcquisition,
  stopSupersededCodexAcquisition
} from './codex-structured-acquisition-lifecycle'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexSessionJournalTranslator } from './codex-structured-session-journal'
import { spawnCodexAppServerConnection } from './codex-app-server-connection'
import { codexSpawnedProcessIdentity } from './codex-structured-owner-identity'
import {
  closeCodexPublishedSession,
  handleCodexSessionExit
} from './codex-structured-session-close'
import { openCodexStructuredSession } from './codex-structured-session-start'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import {
  assertCodexConnectionOpen,
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
  const dispatchEchoes = createCodexDispatchEchoes(() => deps.onHeldSendsChanged?.({ sessionId }))
  let account: AgentSessionAccountKind | undefined
  // Frame row identities include this generation.
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
  const open = deps.openConnection ?? spawnCodexAppServerConnection
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
    const resolvedLaunch = await deps
      .resolveLaunch({
        identity: acquireInput.identity,
        spawnToken: acquireInput.spawnToken,
        ...(acquireInput.permissionMode ? { permissionMode: acquireInput.permissionMode } : {})
      })
      .catch((error: unknown) => {
        throw new AgentSessionPreSpawnError(error)
      })
    const { model: _savedNextModel, ...launchSettings } = resolvedLaunch
    const launch =
      acquireInput.options === undefined
        ? resolvedLaunch
        : {
            ...launchSettings,
            ...(acquireInput.options.model ? { model: acquireInput.options.model } : {})
          }
    acquisitions.assertCurrent(sessionId, attempt)
    account = launch.codexHome ? deps.resolveAccountKind?.(launch.codexHome) : undefined
    const connection = await open(
      {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        ...(launch.env ? { env: launch.env } : {}),
        ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {})
      },
      {
        onNotification: codexAcquisitionNotificationHandler({
          acquisition,
          sessionId,
          dispatchEchoes,
          primaryThreadId: () => primaryThreadId,
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
        onExit: (error, exit) => {
          acquisition.appliedSettings.end()
          try {
            if (attempt.acquisitionGeneration && !sessions.has(sessionId)) {
              attempt.exitProven = true
              attempt.exitError = error
              attempt.dispose?.()
              acquisitions.deleteIfCurrent(sessionId, attempt)
              deps.onEvent?.({
                type: 'ended',
                sessionId,
                fence: acquireInput.fence,
                acquisitionGeneration,
                reason: error.message,
                cause:
                  attempt.cancelled && attempt.requestedClose !== false
                    ? 'requested-close'
                    : 'unexpected-exit',
                failure: attempt.cancelled
                  ? agentSessionFailureFact('hostFault')
                  : agentSessionFailureFact('providerExited', {
                      detail: providerDiagnosticOf(error)
                    }),
                observedAt: deps.now?.() ?? Date.now()
              })
            }
            if (sessions.get(sessionId)?.connection === acquisition.connection) {
              attempt.exitProven = true
              attempt.exitError = error
            }
            handleCodexSessionExit({
              sessions,
              sessionId,
              connection: acquisition.connection,
              error,
              // A previously unproven Orca close still owns this exit.
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
    const process = await spawnIdentity.read(connection.pid)
    acquisitions.assertCurrent(sessionId, attempt)
    assertCodexConnectionOpen(connection, sessionId)
    attempt.acquisitionGeneration = acquisitionGeneration
    let disposed = false
    attempt.dispose = () => {
      if (disposed) {
        return
      }
      disposed = true
      unbindReadingControl?.()
      acquisition.prompts.clear()
      acquisition.drain()
      translator?.dispose()
    }
    attempt.open = (openInput) =>
      openCodexStructuredSession(
        {
          input: acquireInput,
          deps,
          launch,
          account,
          sessions,
          acquisitions,
          attempt,
          connection,
          translator,
          dispatchEchoes,
          subagentExecutions,
          setPrimaryThreadId: (threadId) => {
            primaryThreadId = threadId
          },
          forceCloseUnexpected: input.forceCloseUnexpected,
          ...(unbindReadingControl ? { unbindReadingControl } : {})
        },
        openInput
      )
    return { process, acquisitionGeneration }
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
