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
import {
  claudeAuthDiagnostic,
  readClaudeCapabilities,
  readClaudeFrameString,
  readClaudeInit,
  readClaudeModels
} from './claude-structured-init-proof'
import {
  createClaudeInitDeadline,
  requestClaudeInitialization
} from './claude-structured-init-deadline'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { CLAUDE_SPAWN_TOKEN_ENV, claudeProcessIdentity } from './claude-structured-owner-identity'
import { restoreClaudeStructuredSessionOptions } from './claude-structured-options'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { createClaudeSessionJournalTranslator } from './claude-structured-journal-translation'
import {
  observeClaudeFastModeFacts,
  readClaudeSettingsEffort
} from './claude-structured-session-options'
import {
  claudeStructuredSessionPublicationOptions,
  prepareClaudeStructuredSessionAcquisitionOptions,
  readClaudeStructuredSessionSettings
} from './claude-structured-session-acquisition-options'
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
import { readClaudeTranscriptEntryUuid } from './claude-tui-exit'
import { persistClaudeTurnResumePoint } from './claude-structured-resume-point'
import { withAgentSessionCreatePhase } from '../observability/agent-session-instrumentation'
import { resolveClaudeAcquisitionLaunch } from './claude-structured-acquisition-launch'
import {
  bindClaudeJournalReadingControl,
  createClaudeJournalFailureHandler
} from './claude-structured-session-journal-control'

export const CLAUDE_STRUCTURED_INIT_TIMEOUT_MS = 10_000

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
  // Frames are admitted only after launch resolution proves the provider session
  // this acquisition owns. Keep the check ahead of every stateful consumer.
  const initTimeoutMs = deps.initTimeoutMs ?? CLAUDE_STRUCTURED_INIT_TIMEOUT_MS
  const initDeadline = createClaudeInitDeadline(sessionId, initTimeoutMs)
  const translator = createClaudeSessionJournalTranslator(
    input.events,
    prompts,
    String(input.fence),
    createClaudeJournalFailureHandler({ attempt, initDeadline, callbacks, sessionId })
  )

  const onMessage = (message: Record<string, unknown>): void => {
    const init = readClaudeInit(message)
    if (readClaudeFrameString(message, 'session_id') !== expectedProviderSessionId) {
      // An init proof for another (or unnamed) provider must fail acquisition
      // promptly, while ordinary foreign frames stay quarantined silently.
      if (init || (message.type === 'system' && message.subtype === 'init')) {
        initDeadline.reject(new Error('claude provider session expected'))
      }
      return
    }
    if (init) {
      initDeadline.resolve(init)
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
            if (!attempt.published) {
              initDeadline.reject(error)
            }
          },
          onExit: (error) => {
            if (!attempt.published) {
              initDeadline.reject(error)
            }
            callbacks.handleExit(sessionId, attempt, error)
          }
        }
      )
    )
    attempt.connection = connection
    unbindReadingControl = bindClaudeJournalReadingControl(input.events, connection, translator)
    acquisitions.assertCurrent(sessionId, attempt)
    initDeadline.start()
    const [initialization, init] = await withAgentSessionCreatePhase(
      'init',
      input.recordPhase,
      () =>
        Promise.all([
          requestClaudeInitialization(connection, sessionId, initTimeoutMs),
          initDeadline.promise
        ])
    )
    const models = readClaudeModels(initialization)
    callbacks.deliver(attempt, sessionId, () =>
      callbacks.emit(liveSession, input.events, { type: 'options', sessionId, models })
    )
    initDeadline.clear()
    acquisitions.assertCurrent(sessionId, attempt)
    if (init.providerSessionId !== launch.providerSessionId) {
      throw new Error(
        `claude proved session ${init.providerSessionId}, expected ${launch.providerSessionId}`
      )
    }
    const settings = await readClaudeStructuredSessionSettings(connection, deps.requestTimeoutMs)
    const acquisitionOptions = prepareClaudeStructuredSessionAcquisitionOptions({
      settings,
      initialization,
      inputOptions: input.options,
      resumed: launch.resumed
    })
    callbacks.deliver(attempt, sessionId, () =>
      callbacks.emit(liveSession, input.events, {
        type: 'auth-diagnostic',
        sessionId,
        diagnostic: claudeAuthDiagnostic(init, settings)
      })
    )
    const process = await claudeProcessIdentity(
      { ...input, pid: connection.pid },
      deps.readProcessStartTime
    )
    acquisitions.assertCurrent(sessionId, attempt)
    if (connection.closed) {
      throw new Error(`claude stream-json for session ${sessionId} exited while being acquired`)
    }
    const publication = await withAgentSessionCreatePhase('publish', input.recordPhase, async () =>
      createClaudeSessionPublication({
        connection,
        init,
        initialization,
        leafUuid: observedLeafUuid,
        turnEndLeafUuid: launch.resumeLeafUuid,
        fence: input.fence,
        effort: readClaudeSettingsEffort(settings),
        ...claudeStructuredSessionPublicationOptions(acquisitionOptions),
        resumed: launch.resumed,
        prompts,
        translator,
        events: input.events,
        ...(unbindReadingControl ? { unbindReadingControl } : {}),
        process,
        acquisitionGeneration: mintClaudeAcquisitionGeneration(deps),
        options: acquisitionOptions.options,
        capabilities: readClaudeCapabilities(init, initialization),
        ...(deps.mintLinkId ? { linkId: deps.mintLinkId() } : {}),
        observedAt: deps.now?.() ?? Date.now()
      })
    )
    const acquired: AgentSessionAcquisition = publication.acquisition
    liveSession = publication.session
    await withAgentSessionCreatePhase('restore_options', input.recordPhase, () =>
      restoreClaudeStructuredSessionOptions(liveSession!, deps.requestTimeoutMs)
    )
    acquisitions.assertCurrent(sessionId, attempt)
    acquisitions.deleteIfCurrent(sessionId, attempt)
    await withAgentSessionCreatePhase('publish', input.recordPhase, async () => {
      sessions.set(sessionId, liveSession!)
      attempt.published = true
      for (const event of attempt.buffered.splice(0)) {
        event()
      }
    })
    return acquired
  } catch (error) {
    initDeadline.clear()
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
