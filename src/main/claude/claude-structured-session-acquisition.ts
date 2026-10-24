import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { openClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { buildClaudePermissionCallbacks } from './claude-structured-inbound-control'
import { resolveClaudeReplayTurn } from './claude-replay-turn-resolution'
import { claudeStartedUnechoedSend } from './claude-command-lifecycle'
import { claudeSessionStateEndsTurn } from './claude-session-state-turn-over'
import { settleClaudeTurnEndWaiters } from './claude-request-end-wait'
import {
  createClaudeInitProof,
  readClaudeCapabilities,
  readClaudeFrameString,
  readClaudeInit
} from './claude-structured-init-proof'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { claudeProcessIdentity } from './claude-structured-owner-identity'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { adoptClaudeStructuredSpawnOptions } from './claude-structured-spawn-options'
import { observeClaudeExecutionModel } from './claude-structured-execution-observations'
import { observeClaudeFastModeFacts } from './claude-structured-session-options'
import { createClaudeSessionPublication } from './claude-structured-session-publication'
import {
  mintClaudeAcquisitionGeneration,
  type ClaudeAcquisitionRegistry,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeAcquireCallbacks,
  type ClaudeLateDispatchOutcome
} from './claude-structured-session-state'
import { resolveClaudeAcquisitionError } from './claude-structured-session-close'
import { withObservedProviderExit } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { readClaudeTranscriptEntryUuid } from './claude-transcript-entry-uuid'
import { persistClaudeTurnResumePoint } from './claude-structured-resume-point'
import { withAgentSessionCreatePhase } from '../observability/agent-session-instrumentation'
import { resolveClaudeAcquisitionLaunch } from './claude-structured-acquisition-launch'
import {
  bindClaudeConnectionJournalControls,
  createClaudeSessionJournalTranslator
} from './claude-structured-session-journal-control'

export async function acquireClaudeSession({
  input,
  deps,
  sessions,
  acquisitions,
  exits,
  callbacks
}: {
  input: StructuredAgentSessionAcquireInput
  deps: ClaudeStructuredSessionAdapterDeps
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  exits: Map<string, ClaudeSessionExit>
  callbacks: ClaudeAcquireCallbacks
}): Promise<AgentSessionAcquisition> {
  const sessionId = input.identity.sessionId
  const prompts = new ClaudePromptRegistry()
  const { previous, attempt } = acquisitions.start(sessionId, prompts)
  let unbindReadingControl: (() => void) | undefined
  let liveSession: ClaudeSession | null = null
  let observedLeafUuid: string | null = null,
    expectedProviderSessionId: string | null = null
  // Preserve the CLI diagnostic when SDK cleanup reports a generic error.
  let childEnded: Error | null = null
  const initProof = createClaudeInitProof()
  const translator = createClaudeSessionJournalTranslator(
    input.events,
    String(input.fence),
    {
      attempt,
      initProof,
      callbacks,
      sessionId
    },
    () =>
      liveSession && sessions.get(sessionId) === liveSession
        ? liveSession.backgroundTasks.goalBackgroundWork
        : 'unverifiable'
  )
  const onMessage = (message: Record<string, unknown>): void => {
    const init = readClaudeInit(message)
    if (readClaudeFrameString(message, 'session_id') !== expectedProviderSessionId) {
      // Foreign init frames refuse startup; ordinary foreign frames are ignored.
      if (init || (message.type === 'system' && message.subtype === 'init')) {
        initProof.refuse()
      }
      return
    }
    const modelChanged =
      liveSession && init?.model ? observeClaudeExecutionModel(liveSession, init.model) : false
    if (init) {
      initProof.resolve(init)
      if (liveSession) {
        liveSession.capabilities = readClaudeCapabilities(liveSession.capabilities, init.message)
      }
    }
    observedLeafUuid = readClaudeTranscriptEntryUuid(message) ?? observedLeafUuid
    if (liveSession) {
      liveSession.leafUuid = observedLeafUuid
      observeClaudeFastModeFacts(liveSession, message)
      // Late results after exit cannot update the resume point.
      if (message.type === 'result' && sessions.get(sessionId) === liveSession) {
        persistClaudeTurnResumePoint(sessionId, liveSession, deps)
      }
      if (claudeSessionStateEndsTurn(message) && sessions.get(sessionId) === liveSession) {
        settleClaudeTurnEndWaiters(liveSession)
      }
    }
    // Publish the echoed turn before settling its send to avoid transient idle status.
    const settlements: ClaudeLateDispatchOutcome[] = []
    const turnOrigin = liveSession
      ? resolveClaudeReplayTurn(liveSession, message, (settlement) => settlements.push(settlement))
      : null
    const startsTurn = turnOrigin !== null
    // Use host time for turn endpoints; provider timestamps may use a different clock.
    const observedAt =
      startsTurn || message.type === 'result' ? { observedAt: deps.now?.() ?? Date.now() } : {}
    const requestedAt = turnOrigin?.requestedAt
    const startedSend = !startsTurn && liveSession ? claudeStartedUnechoedSend(liveSession) : null
    // Retain send ownership during publication until the host receives its settlement.
    const session = liveSession
    const reported = session?.unreportedSettlements
    if (session && settlements.length > 0) {
      session.unreportedSettlements = new Set([
        ...(reported ?? []),
        ...settlements.map((settlement) => settlement.clientMessageId)
      ])
    }
    try {
      callbacks.deliver(attempt, sessionId, () => {
        if (modelChanged && liveSession && init?.model) {
          callbacks.emit(liveSession, input.events, {
            type: 'options-reported',
            sessionId,
            fence: liveSession.fence,
            acquisitionGeneration: liveSession.acquisitionGeneration,
            reportedOptions: { model: init.model }
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
      })
    } finally {
      try {
        for (const settlement of settlements) {
          deps.onDispatchSettledLate?.({ sessionId, ...settlement })
        }
      } finally {
        if (session) {
          session.unreportedSettlements = reported
        }
      }
    }
  }
  const emit = (event: Parameters<typeof callbacks.emit>[2]): void =>
    callbacks.deliver(attempt, sessionId, () => callbacks.emit(liveSession, input.events, event))
  const { canUseTool, onUserDialog } = buildClaudePermissionCallbacks({ sessionId, prompts, emit })

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
    attempt.account = launch.account
    observedLeafUuid = launch.resumeLeafUuid
    const open = deps.openConnection ?? openClaudeStreamJsonConnection
    const connection = await withAgentSessionCreatePhase('spawn', input.recordPhase, () =>
      open(
        {
          pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
          options: launch.options,
          cwd: launch.cwd,
          env: {
            ...launch.env,
            // The saved account directory must override a conflicting environment overlay.
            ...claudeConfigDirEnvPatch(
              launch.claudeConfigDir,
              launch.env ? { env: launch.env } : {}
            )
          },
          ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {})
        },
        {
          onMessage,
          canUseTool,
          onUserDialog,
          onFault: (error) => {
            childEnded ??= error
            initProof.reject(error)
          },
          onExit: (error, exit) => {
            if (exit?.expected) {
              callbacks.finishClose(sessionId, attempt)
              return
            }
            // Mark in place because the fault report may retain this error object.
            withObservedProviderExit(error)
            childEnded ??= error
            initProof.reject(error)
            callbacks.handleExit(sessionId, attempt, error)
          }
        }
      )
    )
    attempt.connection = connection
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
    const publication = createClaudeSessionPublication({
      connection,
      providerSessionId: launch.providerSessionId,
      leafUuid: observedLeafUuid,
      turnEndLeafUuid: launch.resumeLeafUuid,
      fence: input.fence,
      continuesChain: launch.continuesChain,
      ...(launch.forkedFromKey ? { forkedFromKey: launch.forkedFromKey } : {}),
      prompts,
      translator,
      events: input.events,
      ...(unbindReadingControl ? { unbindReadingControl } : {}),
      process,
      acquisitionGeneration: mintClaudeAcquisitionGeneration(deps),
      options: launch.savedOptions.options,
      initialization: {
        proof: initProof,
        account: launch.account,
        resumesTranscript: launch.resumesTranscript,
        onLateRefusal: (error) => callbacks.handleExit(sessionId, attempt, error)
      },
      ...(deps.mintLinkId ? { linkId: deps.mintLinkId() } : {}),
      observedAt: deps.now?.() ?? Date.now()
    })
    const session = publication.session
    liveSession = session
    adoptClaudeStructuredSpawnOptions(session, launch.savedOptions)
    acquisitions.deleteIfCurrent(sessionId, attempt)
    await withAgentSessionCreatePhase('publish', input.recordPhase, async () => {
      sessions.set(sessionId, session)
      attempt.published = true
      for (const event of attempt.buffered.splice(0)) {
        event()
      }
    })
    // Buffered exit delivery can remove the session during publication.
    if (sessions.get(sessionId) !== session) {
      throw (
        exits.get(sessionId)?.error ?? new Error('claude session ended before acquisition returned')
      )
    }
    return publication.acquisition
  } catch (error) {
    unbindReadingControl?.()
    const acquisitionError = await resolveClaudeAcquisitionError({
      error,
      sessionId,
      sessions,
      attempt,
      translator,
      prompts,
      releaseAcquisition: () => acquisitions.deleteIfCurrent(sessionId, attempt)
    })
    throw acquisitionError
  } finally {
    attempt.finish()
  }
}
