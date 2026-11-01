import { stopAgentSessionProviderRoot } from '../native-chat/agent-session-wire/structured-agent-session-provider-exit-proof'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import {
  CODEX_STRUCTURED_HANDLE_NAMESPACE,
  isAgentSessionProviderHandleInNamespace
} from '../../shared/agent-session-provider-handle-encoding'
import {
  launchPreparationFailure,
  type AgentSessionAcquisition
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  closeFailedCodexAcquisition,
  stopSupersededCodexAcquisition
} from './codex-structured-acquisition-lifecycle'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import {
  createCodexSessionJournalTranslator,
  createCodexAcquisitionJournalDisposer
} from './codex-structured-session-journal'
import { spawnCodexAppServerConnection } from './codex-app-server-connection'
import { codexSpawnedProcessIdentity } from './codex-structured-owner-identity'
import {
  closeCodexPublishedSession,
  handleCodexSessionExit,
  observeCodexSessionExit
} from './codex-structured-session-close'
import { openCodexStructuredSession } from './codex-structured-session-start'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import { providerSpawnAbsent } from '../provider-process/provider-executable-missing'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import {
  assertCodexConnectionOpen,
  mintCodexAcquisitionGeneration
} from './codex-structured-session-state'
import type { CodexStructuredAcquisitionInput } from './codex-structured-acquisition-window'
import { readCodexThreadId } from './codex-structured-thread-facts'
import { codexAcquisitionNotificationHandler } from './codex-structured-acquisition-notification'

export async function acquireCodexStructuredSession(
  input: CodexStructuredAcquisitionInput
): Promise<AgentSessionAcquisition> {
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
  attempt.dispose = createCodexAcquisitionJournalDisposer(acquisition, translator, () =>
    unbindReadingControl?.()
  )
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
    const previousSession = sessions.get(sessionId)
    if (
      !(await stopAgentSessionProviderRoot(
        () =>
          closeCodexPublishedSession(
            sessions,
            sessionId,
            deps.onEvent,
            deps.logger ? { logger: deps.logger } : {}
          ),
        (error) =>
          neverThrowingStructuredAgentSessionLogger(
            deps.logger ?? createStructuredAgentSessionLogger()
          ).warn('Previous Codex session stopped with a diagnostic', {
            scope: 'codex-prior-session-close',
            sessionId,
            fence: previousSession?.fence,
            acquisitionGeneration: previousSession?.acquisitionGeneration,
            error
          })
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
        throw launchPreparationFailure(error)
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
          onRetired: (method, params, observedAt, dispatchSequenceAtReceipt) => {
            const threadId = readCodexThreadId(params) ?? primaryThreadId
            if (threadId) {
              translator?.handle({
                type: 'notification',
                sessionId,
                threadId,
                method,
                params,
                ...(observedAt === undefined ? {} : { observedAt }),
                ...(dispatchSequenceAtReceipt === undefined ? {} : { dispatchSequenceAtReceipt })
              })
            }
          },
          deliver: input.deliver,
          now: deps.now ?? Date.now
        }),
        onServerRequest: (request) =>
          input.deliver(acquisition, sessionId, () => {
            const threadId = readCodexThreadId(request.params) ?? primaryThreadId
            if (acquisition.isRetired && threadId) {
              translator?.handle({
                type: 'server-request',
                sessionId,
                threadId,
                method: request.method,
                params: request.params
              })
            } else {
              input.handleServerRequest(sessionId, request)
            }
          }),
        onUnhandledFrame: (kind, payload) =>
          input.deliver(acquisition, sessionId, () => {
            const threadId = readCodexThreadId(payload) ?? primaryThreadId
            if (acquisition.isRetired && threadId) {
              translator?.handle({ type: 'provider-frame', sessionId, threadId, kind, payload })
            } else {
              input.handleUnhandledFrame(sessionId, kind, payload)
            }
          }),
        onSpawned: spawnIdentity.onSpawned,
        onExit: (error, exit) => {
          const observedAt = deps.now?.() ?? Date.now()
          observeCodexSessionExit(sessions.get(sessionId), acquisition.connection, observedAt)
          const finish = (): void => {
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
                    : providerSpawnAbsent(error)
                      ? providerStartupFailureFact(error)
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
          return exit?.inputDone ? exit.inputDone.then(finish, finish) : finish()
        }
      }
    )
    acquisition.connection = connection
    acquisitions.assertCurrent(sessionId, attempt)
    const process = await spawnIdentity.read(connection.pid)
    acquisitions.assertCurrent(sessionId, attempt)
    assertCodexConnectionOpen(connection, sessionId)
    attempt.acquisitionGeneration = acquisitionGeneration
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
          bindReadingControl: () => {
            if (connection.pauseReading && connection.resumeReading) {
              unbindReadingControl = acquireInput.events?.bindReadingControl?.({
                pauseReading: connection.pauseReading,
                resumeReading: () => {
                  connection.resumeReading?.()
                  notificationRetries.retry(sessionId, connection)
                }
              })
            }
            return unbindReadingControl
          }
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
          attempt.dispose?.()
        }
      })
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    throw error
  } finally {
    attempt.finish()
  }
}
