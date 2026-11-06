import type { AgentSessionAcquisition } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { openClaudeStreamJsonConnection } from '../claude-stream-json-connection'
import { claudeLaunchPermissions } from './claude-structured-inbound-control'
import {
  resolveClaudeReplayTurn,
  withClaudeReplaySettlements
} from '../claude-replay-turn-resolution'
import { claudeStartedUnechoedSend } from '../claude-command-lifecycle'
import { claudeSessionStateEndsTurn } from '../claude-session-state-turn-over'
import { settleClaudeTurnEndWaiters } from '../claude-request-end-wait'
import * as proof from './claude-structured-init-proof'
import { claudeConfigDirEnvPatch } from '../claude-config-dir-pin'
import { claudeProcessIdentity } from './claude-structured-owner-identity'
import { ClaudePromptRegistry } from '../claude-prompt-registry'
import { adoptClaudeStructuredSpawnOptions } from './launch/claude-structured-spawn-options'
import { observeClaudeFrameModels } from './claude-structured-execution-observations'
import { observeClaudeFastModeFacts } from './launch/claude-structured-session-options'
import {
  createClaudeSessionPublication,
  reportClaudeOptions,
  publishClaudeSessionAttempt
} from './claude-structured-session-publication'
import type * as sessionState from './claude-structured-session-state'
import { resolveClaudeAcquisitionError } from './claude-structured-session-close'
import { claudeStartupError, claudeStartupExit } from './claude-structured-session-startup-exit'
import { readClaudeTranscriptEntryUuid } from '../claude-transcript-entry-uuid'
import { claudeTurnResumePointWriter } from './claude-structured-resume-point'
import { withAgentSessionCreatePhase } from '../../observability/agent-session-instrumentation'
import { resolveClaudeAcquisitionLaunch } from './launch/claude-structured-acquisition-launch'
import {
  bindClaudeConnectionJournalControls,
  createClaudeSessionJournalTranslator
} from './journal/claude-structured-session-journal-control'
import { isRootClaudeFrame } from '../claude-turn-opening'
import { createClaudeStartupOutcome, endsClaudeStartup } from './claude-structured-startup-outcome'
import { claudeStartupResultError } from '../claude-stream-json-exit-error'
import {
  claudePluginUiRecovery,
  ignoresClaudeRetiredConnection
} from './claude-structured-plugin-ui-recovery'

export async function acquireClaudeSession({
  input,
  deps,
  sessions,
  acquisitions,
  exits,
  naming,
  callbacks
}: Omit<
  Parameters<typeof resolveClaudeAcquisitionLaunch>[0],
  'previous' | 'attempt'
>): Promise<AgentSessionAcquisition> {
  const sessionId = input.identity.sessionId
  const prompts = new ClaudePromptRegistry()
  const { previous, attempt } = acquisitions.start(sessionId, prompts)
  let unbindReadingControl: (() => void) | undefined
  let liveSession: sessionState.ClaudeSession | null = null
  let firstRootInit: sessionState.ClaudeSession['firstRootInit']
  let observedLeafUuid: string | null = null,
    expectedProviderSessionId: string | null = null
  // Preserve the CLI diagnostic when SDK cleanup reports a generic error.
  let childEnded: Error | null = null
  const initProof = proof.createClaudeInitProof()
  // Owned by this acquisition alone, so a late frame cannot fail a replacement's open.
  const startup = createClaudeStartupOutcome()
  const childFailed = (error: Error, ended?: Promise<unknown>): void => {
    childEnded ??= error
    void (ended ? ended.then(startup.fail) : endsClaudeStartup(error) && startup.fail(error))
    initProof.reject(error)
  }
  const delivery = { attempt, initProof, callbacks, sessionId, sessions }
  const translator = createClaudeSessionJournalTranslator(
    input.events,
    String(input.fence),
    delivery,
    () => (liveSession && sessions.get(sessionId) === liveSession ? liveSession : null),
    (message) => startup.accept(claudeStartupResultError(message))
  )
  const contextActivity = translator?.contextActivity ?? 0
  const recordTurnEnd = claudeTurnResumePointWriter(sessionId, sessions, deps)
  const observedOptions: sessionState.ClaudeSession['reportedOptions'] = {}
  const handlePluginUi = claudePluginUiRecovery(delivery, () => liveSession)
  const onMessage = (message: Record<string, unknown>): void => {
    if (
      ignoresClaudeRetiredConnection(liveSession, sessions.get(sessionId), exits.get(sessionId))
    ) {
      return
    }
    const init = proof.readClaudeInit(message)
    if (proof.readClaudeFrameString(message, 'session_id') !== expectedProviderSessionId) {
      // Foreign init frames refuse startup; ordinary foreign frames are ignored.
      if (init || (message.type === 'system' && message.subtype === 'init')) {
        initProof.refuse()
      }
      return
    }
    if (handlePluginUi(message)) {
      return
    }
    if (message.type === 'system' && message.subtype === 'init' && isRootClaudeFrame(message)) {
      firstRootInit ??= {
        permissionMode: proof.readClaudeFrameString(message, 'permissionMode')
      }
      if (liveSession) {
        liveSession.firstRootInit = firstRootInit
      }
    }
    const permissionChanged = proof.observeClaudeReportedPermissionMode(observedOptions, message)
    const modelReport = observeClaudeFrameModels(liveSession, message, init?.model)
    if (init) {
      initProof.resolve(init)
      if (liveSession) {
        liveSession.capabilities = proof.readClaudeCapabilities(
          liveSession.capabilities,
          init.message
        )
      }
    }
    observedLeafUuid = readClaudeTranscriptEntryUuid(message) ?? observedLeafUuid
    const leafAtFrame = observedLeafUuid
    if (liveSession) {
      liveSession.leafUuid = observedLeafUuid
      observeClaudeFastModeFacts(liveSession, message)
      if (message.type === 'result' && sessions.get(sessionId) === liveSession) {
        reportClaudeOptions(liveSession, sessions, input, deps.requestTimeoutMs, attempt, callbacks)
      }
      if (claudeSessionStateEndsTurn(message) && sessions.get(sessionId) === liveSession) {
        settleClaudeTurnEndWaiters(liveSession)
      }
    }
    // Publish the echoed turn before settling its send to avoid transient idle status.
    const settlements: sessionState.ClaudeLateDispatchOutcome[] = []
    const turnOrigin = liveSession
      ? resolveClaudeReplayTurn(liveSession, message, (settlement) => settlements.push(settlement))
      : null
    const startsTurn = turnOrigin !== null
    // Use host time for turn endpoints; provider timestamps may use a different clock.
    const observedAt =
      startsTurn || message.type === 'result' ? { observedAt: deps.now?.() ?? Date.now() } : {}
    const requestedAt = turnOrigin?.requestedAt
    const startedSend = !startsTurn && liveSession ? claudeStartedUnechoedSend(liveSession) : null
    withClaudeReplaySettlements(
      liveSession,
      settlements,
      () =>
        callbacks.deliver(attempt, sessionId, () => {
          if (liveSession && (modelReport || permissionChanged)) {
            callbacks.emit(liveSession, input.events, {
              type: 'options-reported',
              sessionId,
              fence: liveSession.fence,
              acquisitionGeneration: liveSession.acquisitionGeneration,
              reportedOptions: {
                ...modelReport,
                reportedModel: liveSession.reportedOptions.reportedModel,
                reportedPermissionMode: observedOptions.reportedPermissionMode
              }
            })
          }
          callbacks.emit(liveSession, input.events, {
            type: 'message',
            sessionId,
            message,
            ...(startsTurn ? { startsTurn: true } : {}),
            ...(requestedAt === null || requestedAt === undefined ? {} : { requestedAt }),
            ...(turnOrigin?.clientMessageId ? { clientMessageId: turnOrigin.clientMessageId } : {}),
            ...(startedSend ? { startedSend } : {}),
            ...observedAt
          })
          // Final snapshots and the turn settlement must reach the journal before its leaf can move.
          recordTurnEnd(liveSession, message, leafAtFrame)
        }),
      (settlement) => deps.onDispatchSettledLate?.({ sessionId, ...settlement })
    )
  }
  const emit = (event: Parameters<typeof callbacks.emit>[2]): void =>
    callbacks.deliver(attempt, sessionId, () => callbacks.emit(liveSession, input.events, event))

  try {
    const launch = await resolveClaudeAcquisitionLaunch({
      input,
      deps,
      sessions,
      acquisitions,
      exits,
      callbacks,
      previous,
      attempt
    })
    expectedProviderSessionId = launch.providerSessionId
    // Granted from this final launch before the connection can deliver a request.
    const permissions = claudeLaunchPermissions({ sessionId, prompts, emit }, launch)
    naming?.launch(launch)
    attempt.account = launch.account
    observedLeafUuid = launch.resumeLeafUuid
    const connection = await withAgentSessionCreatePhase('spawn', input.recordPhase, () =>
      (deps.openConnection ?? openClaudeStreamJsonConnection)(
        {
          pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
          prefixArgs: launch.prefixArgs,
          options: launch.options,
          cwd: launch.cwd,
          env: {
            ...launch.env,
            // The saved account directory must override a conflicting environment overlay.
            ...claudeConfigDirEnvPatch(launch.claudeConfigDir, { env: launch.env })
          },
          ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {})
        },
        {
          onMessage,
          ...permissions.handlers,
          onFault: childFailed,
          onExit: permissions.closeThen((error, exit) => {
            if (exit?.expected) {
              naming?.failed()
              callbacks.finishClose(sessionId, attempt)
              return
            }
            childFailed(...claudeStartupExit(error, attempt.connection, input.events))
            if (exits.get(sessionId)?.connection === attempt.connection) {
              callbacks.finishClose(sessionId, attempt)
            } else {
              callbacks.handleExit(sessionId, attempt, error)
            }
          })
        }
      )
    )
    attempt.connection = connection
    naming?.attach(connection)
    unbindReadingControl = bindClaudeConnectionJournalControls(
      input.events,
      connection,
      translator,
      deps.now ? { now: deps.now } : {}
    )
    acquisitions.assertCurrent(sessionId, attempt)
    if (connection.pid === undefined) {
      // Await the spawn diagnostic instead of reporting only a missing PID.
      await initProof.promise
    }
    const process = await claudeProcessIdentity(
      { ...input, pid: connection.pid },
      deps.readProcessStartTime
    ).catch((error: unknown) => {
      throw childEnded ?? error
    })
    acquisitions.assertCurrent(sessionId, attempt)
    if (connection.closed) {
      throw (
        childEnded ??
        new Error(`claude stream-json for session ${sessionId} exited while being acquired`)
      )
    }
    const { session, acquisition } = createClaudeSessionPublication({
      connection,
      launch,
      request: input,
      deps,
      leafUuid: observedLeafUuid,
      prompts,
      translator,
      ...(unbindReadingControl ? { unbindReadingControl } : {}),
      process,
      initialization: {
        proof: initProof,
        contextActivity,
        onLateRefusal: (error) => callbacks.handleExit(sessionId, attempt, error),
        startup,
        emit,
        naming
      }
    })
    session.reportedOptions = observedOptions
    liveSession = session
    session.firstRootInit = firstRootInit
    session.orderedPermissionMode = permissions.orderedMode
    adoptClaudeStructuredSpawnOptions(session, {
      ...launch.savedOptions,
      sdkOptions: launch.options
    })
    acquisitions.deleteIfCurrent(sessionId, attempt)
    await publishClaudeSessionAttempt({
      sessionId,
      session,
      attempt,
      callbacks,
      sessions,
      exits,
      recordPhase: input.recordPhase
    })
    return acquisition
  } catch (error) {
    unbindReadingControl?.()
    throw await resolveClaudeAcquisitionError({
      error: await claudeStartupError(error, attempt.connection),
      sessionId,
      sessions,
      attempt,
      translator,
      prompts,
      releaseAcquisition: () => acquisitions.deleteIfCurrent(sessionId, attempt)
    })
  } finally {
    attempt.finish()
  }
}
