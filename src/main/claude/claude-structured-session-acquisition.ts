import {
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE } from '../claude-accounts/environment'
import { isClaudeAuthSwitchInProgress } from '../claude-accounts/live-pty-gate'
import { openClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { buildClaudePermissionCallbacks } from './claude-structured-inbound-control'
import { resolveClaudeReplayTurn } from './claude-structured-dispatch'
import { readClaudeFrameString, readClaudeInit } from './claude-structured-init-proof'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { CLAUDE_SPAWN_TOKEN_ENV, claudeProcessIdentity } from './claude-structured-owner-identity'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { restoredClaudeStructuredSessionOptions } from './claude-structured-options'
import { createClaudeSessionJournalTranslator } from './claude-structured-journal-translation'
import { observeClaudeFastModeFacts } from './claude-structured-session-options'
import {
  createClaudeInitProof,
  readClaudeStartupFacts,
  settleClaudeSessionStartup
} from './claude-structured-session-startup'
import { createClaudeSessionPublication } from './claude-structured-session-publication'
import {
  mintClaudeAcquisitionGeneration,
  type ClaudeAcquisitionRegistry,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeAcquireCallbacks
} from './claude-structured-session-state'
import { resolveClaudeAcquisitionError } from './claude-structured-session-close'
import { readClaudeTranscriptEntryUuid } from './claude-transcript-entry-uuid'
import { persistClaudeTurnResumePoint } from './claude-structured-resume-point'
import { withAgentSessionCreatePhase } from '../observability/agent-session-instrumentation'
import { resolveClaudeAcquisitionLaunch } from './claude-structured-acquisition-launch'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import {
  bindClaudeConnectionJournalControls,
  createClaudeJournalFailureHandler
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
  // A managed-account switch is mid-swap of the pinned credential home; refuse here,
  // before this acquisition cancels the previous attempt and closes the live session.
  if (isClaudeAuthSwitchInProgress()) {
    throw new AgentSessionPreSpawnError(new Error(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE))
  }
  const sessionId = input.identity.sessionId
  const prompts = new ClaudePromptRegistry()
  const { previous, attempt } = acquisitions.start(sessionId, prompts)
  let unbindReadingControl: (() => void) | undefined
  let liveSession: ClaudeSession | null = null
  let observedLeafUuid: string | null = null,
    expectedProviderSessionId: string | null = null
  // The CLI's own account of why it ended (stderr included): the only reason a user can act on.
  let childEnded: Error | null = null
  // Frames are admitted only after launch resolution proves the provider session
  // this acquisition owns. Keep the check ahead of every stateful consumer.
  const initProof = createClaudeInitProof()
  const translator = createClaudeSessionJournalTranslator(
    input.events,
    prompts,
    String(input.fence),
    createClaudeJournalFailureHandler({ attempt, initProof, callbacks, sessionId })
  )

  const onMessage = (message: Record<string, unknown>): void => {
    const init = readClaudeInit(message)
    if (readClaudeFrameString(message, 'session_id') !== expectedProviderSessionId) {
      // An init proof for another (or unnamed) provider must fail acquisition
      // promptly, while ordinary foreign frames stay quarantined silently.
      if (init || (message.type === 'system' && message.subtype === 'init')) {
        initProof.reject(new Error('claude provider session expected'))
      }
      return
    }
    if (init) {
      initProof.resolve(init)
      // Every turn opens with an init frame naming the model the CLI is actually
      // running; set_model answers success for a model it never resolves, so this
      // report is the session's only adoption evidence.
      if (liveSession && init.model) {
        liveSession.reportedOptions.model = init.model
        liveSession.reportedModelMutation = liveSession.optionMutationSequence
      }
    }
    observedLeafUuid = readClaudeTranscriptEntryUuid(message) ?? observedLeafUuid
    if (liveSession) {
      liveSession.leafUuid = observedLeafUuid
      observeClaudeFastModeFacts(liveSession, message)
      // Recording a turn end is an owner action; a result that trails the child's exit has no owner.
      if (message.type === 'result' && sessions.get(sessionId) === liveSession) {
        persistClaudeTurnResumePoint(sessionId, liveSession, deps)
      }
    }
    const turnOrigin = liveSession
      ? resolveClaudeReplayTurn(liveSession, message, (settlement) =>
          deps.onDispatchSettledLate?.({ sessionId, ...settlement })
        )
      : null
    const startsTurn = turnOrigin !== null
    // Turn endpoints are stamped on the host clock, never the frame's own timestamp.
    const observedAt =
      startsTurn || message.type === 'result' ? { observedAt: deps.now?.() ?? Date.now() } : {}
    const requestedAt = turnOrigin?.requestedAt
    callbacks.deliver(attempt, sessionId, () =>
      callbacks.emit(liveSession, input.events, {
        type: 'message',
        sessionId,
        message,
        ...(startsTurn ? { startsTurn: true } : {}),
        ...(requestedAt === null || requestedAt === undefined ? {} : { requestedAt }),
        ...observedAt
      })
    )
  }
  const { canUseTool, onUserDialog } = buildClaudePermissionCallbacks({
    sessionId,
    prompts,
    currentTurnId: () => translator?.currentTurnId ?? null,
    emit: (event) =>
      callbacks.deliver(attempt, sessionId, () => callbacks.emit(liveSession, input.events, event))
  })

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
            [CLAUDE_SPAWN_TOKEN_ENV]: input.spawnToken,
            // Compared against what the child would otherwise inherit, so the record's
            // account home still wins over a diverging overlay without a needless pin.
            // (`process` is shadowed by a local later in this function, so it is not named here.)
            ...claudeConfigDirEnvPatch(
              launch.claudeConfigDir,
              launch.env ? { env: launch.env } : {}
            )
          }
        },
        {
          onMessage,
          canUseTool,
          onUserDialog,
          onFault: (error) => {
            childEnded ??= error
            initProof.reject(error)
          },
          onExit: (error) => {
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
    const emit = (event: Parameters<typeof callbacks.emit>[2]): void =>
      callbacks.deliver(attempt, sessionId, () => callbacks.emit(liveSession, input.events, event))
    if (connection.pid === undefined) {
      // A pid-less spawn always reports its error next; surface that, not the missing pid.
      await initProof.promise
    }
    const process = await claudeProcessIdentity(
      { ...input, pid: connection.pid },
      deps.readProcessStartTime
    ).catch((error: unknown) => {
      // A child that already ended explains why its start time could not be read.
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
      prompts,
      translator,
      events: input.events,
      ...(unbindReadingControl ? { unbindReadingControl } : {}),
      process,
      acquisitionGeneration: mintClaudeAcquisitionGeneration(deps),
      options: restoredClaudeStructuredSessionOptions(input.options),
      ...(deps.mintLinkId ? { linkId: deps.mintLinkId() } : {}),
      observedAt: deps.now?.() ?? Date.now()
    })
    const session = publication.session
    liveSession = session
    const catalogAccess = agentModelCatalogSessionAccess(
      deps.modelCatalog,
      'claude',
      launch.claudeConfigDir
    )
    if (catalogAccess) {
      session.catalogAccess = catalogAccess
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    await withAgentSessionCreatePhase('publish', input.recordPhase, async () => {
      sessions.set(sessionId, session)
      attempt.published = true
      for (const event of attempt.buffered.splice(0)) {
        event()
      }
    })
    session.startup.settled = settleClaudeSessionStartup({
      session,
      facts: readClaudeStartupFacts({
        connection,
        initProof,
        sessionId,
        providerSessionId: launch.providerSessionId,
        resumesTranscript: launch.resumesTranscript,
        inputOptions: input.options,
        requestTimeoutMs: deps.requestTimeoutMs,
        emit
      }),
      isCurrent: () => sessions.get(sessionId) === session,
      requestTimeoutMs: deps.requestTimeoutMs,
      fault: (error) => callbacks.handleExit(sessionId, attempt, error),
      onStarted: (options) =>
        emit({
          type: 'started',
          sessionId,
          fence: input.fence,
          acquisitionGeneration: session.acquisitionGeneration,
          ...options
        })
    })
    // A child whose exit already reached `handleExit` is not handed over as live: the create
    // fails with the CLI's own diagnostic, as one that died before publish does.
    if (sessions.get(sessionId) !== session) {
      throw (
        exits.get(sessionId)?.error ?? new Error('claude session ended before acquisition returned')
      )
    }
    // The start applies its facts and restores saved options only after publish, so the child
    // is `starting` until `started` says otherwise.
    return { ...publication.acquisition, providerChildPhase: 'starting' }
  } catch (error) {
    unbindReadingControl?.()
    const acquisitionError = await resolveClaudeAcquisitionError({
      error,
      sessionId,
      sessions,
      attempt,
      translator,
      prompts
    })
    acquisitions.deleteIfCurrent(sessionId, attempt)
    throw acquisitionError
  } finally {
    attempt.finish()
  }
}
