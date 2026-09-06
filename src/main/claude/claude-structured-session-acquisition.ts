import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionPreSpawnError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE } from '../claude-accounts/environment'
import { isClaudeAuthSwitchInProgress } from '../claude-accounts/live-pty-gate'
import { openClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { buildClaudePermissionCallbacks } from './claude-structured-inbound-control'
import { resolveClaudeReplayWaiter } from './claude-structured-dispatch'
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
import {
  restoreClaudeStructuredSessionOptions,
  restoredClaudeStructuredSessionOptions
} from './claude-structured-options'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { createClaudeSessionJournalTranslator } from './claude-structured-journal-translation'
import { readClaudeSettingsEffort } from './claude-structured-session-options'
import { createClaudeSessionPublication } from './claude-structured-session-publication'
import {
  cancelClaudeAcquisitionAttempt,
  mintClaudeAcquisitionGeneration,
  type ClaudeAcquisitionRegistry,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeAcquireCallbacks
} from './claude-structured-session-state'
import {
  closeClaudePublishedSessionForDeps,
  claudeAcquisitionCleanupError
} from './claude-structured-session-close'
import { readClaudeTranscriptEntryUuid } from './claude-tui-exit'

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
  const translator = createClaudeSessionJournalTranslator(
    input.events,
    prompts,
    String(input.fence)
  )
  const { previous, attempt } = acquisitions.start(sessionId, prompts)
  let liveSession: ClaudeSession | null = null
  let observedLeafUuid: string | null = null,
    expectedProviderSessionId: string | null = null
  // Frames are admitted only after launch resolution proves the provider session
  // this acquisition owns. Keep the check ahead of every stateful consumer.
  const initTimeoutMs = deps.initTimeoutMs ?? CLAUDE_STRUCTURED_INIT_TIMEOUT_MS
  const initDeadline = createClaudeInitDeadline(sessionId, initTimeoutMs)

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
    }
    const startsTurn = liveSession ? resolveClaudeReplayWaiter(liveSession, message) : false
    callbacks.deliver(attempt, sessionId, () =>
      callbacks.emit(liveSession, input.events, {
        type: 'message',
        sessionId,
        message,
        ...(startsTurn ? { startsTurn: true } : {})
      })
    )
  }
  const { canUseTool, onUserDialog } = buildClaudePermissionCallbacks({
    sessionId,
    prompts,
    emit: (event) =>
      callbacks.deliver(attempt, sessionId, () => callbacks.emit(liveSession, input.events, event))
  })

  try {
    if (previous && !(await cancelClaudeAcquisitionAttempt(previous))) {
      acquisitions.restoreIfCurrent(sessionId, attempt, previous)
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`claude acquisition for session ${sessionId} could not be stopped`)
      )
    }
    acquisitions.assertCurrent(sessionId, attempt)
    let resumeSession = sessions.get(sessionId)
    if (!(await closeClaudePublishedSessionForDeps(sessions, sessionId, deps))) {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`claude session ${sessionId} could not be stopped`)
      )
    }
    // A first-hand exit that has not yet proved its full tree still owns a cleanup
    // obligation; never let a new acquisition hide that evidence by omission.
    const retainedExit = exits.get(sessionId)
    if (retainedExit) {
      const firstProof = retainedExit.closePromise ? await retainedExit.closePromise : false
      const proven = firstProof || (await retainedExit.connection.close().catch(() => false))
      if (!proven) {
        throw claudeAcquisitionCleanupError(retainedExit.connection, retainedExit.error)
      }
      // The old child is superseded by this acquisition. Settle its lifecycle
      // before discarding the retained proof so its cursor and callbacks are
      // cleaned up exactly once.
      await callbacks.settleExit(sessionId, retainedExit)
      resumeSession ??= retainedExit.session
    }
    acquisitions.assertCurrent(sessionId, attempt)
    // Both close paths persist their final leaf, so launch validates that durable head.
    const launchIdentity = resumeSession
      ? {
          ...input.identity,
          providerHandle: {
            kind: 'claude' as const,
            sessionId: resumeSession.providerSessionId,
            leafUuid: resumeSession.leafUuid
          }
        }
      : input.identity
    const launch = await deps
      .resolveLaunch({ identity: launchIdentity })
      .catch((error: unknown) => {
        throw error instanceof AgentSessionPreSpawnError
          ? error
          : new AgentSessionPreSpawnError(error)
      })
    expectedProviderSessionId = launch.providerSessionId
    observedLeafUuid = launch.resumeLeafUuid
    acquisitions.assertCurrent(sessionId, attempt)
    const open = deps.openConnection ?? openClaudeStreamJsonConnection
    const connection = await open(
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
          ...claudeConfigDirEnvPatch(launch.claudeConfigDir, launch.env ? { env: launch.env } : {})
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
    attempt.connection = connection
    acquisitions.assertCurrent(sessionId, attempt)
    initDeadline.start()
    const [initialization, init] = await Promise.all([
      requestClaudeInitialization(connection, sessionId, initTimeoutMs),
      initDeadline.promise
    ])
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
    const settings = await connection
      .getSettings({ timeoutMs: deps.requestTimeoutMs })
      .catch(() => null)
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
    const publication = createClaudeSessionPublication({
      connection,
      init,
      claudeConfigDir: launch.claudeConfigDir,
      leafUuid: observedLeafUuid,
      fence: input.fence,
      effort: readClaudeSettingsEffort(settings),
      resumed: launch.resumed,
      prompts,
      translator,
      events: input.events,
      process,
      acquisitionGeneration: mintClaudeAcquisitionGeneration(deps),
      options: restoredClaudeStructuredSessionOptions(input.options),
      capabilities: readClaudeCapabilities(init, initialization),
      ...(deps.mintLinkId ? { linkId: deps.mintLinkId() } : {}),
      observedAt: deps.now?.() ?? Date.now()
    })
    const acquired: AgentSessionAcquisition = publication.acquisition
    liveSession = publication.session
    await restoreClaudeStructuredSessionOptions(liveSession, deps.requestTimeoutMs)
    acquisitions.assertCurrent(sessionId, attempt)
    acquisitions.deleteIfCurrent(sessionId, attempt)
    sessions.set(sessionId, liveSession)
    attempt.published = true
    for (const event of attempt.buffered.splice(0)) {
      event()
    }
    return acquired
  } catch (error) {
    initDeadline.clear()
    let acquisitionError = error
    if (sessions.get(sessionId)?.connection !== attempt.connection) {
      translator?.dispose()
      // Settle any callback that fired before the failure so no SDK promise dangles.
      for (const prompt of prompts.clear()) {
        prompt.settle(null)
      }
      const closed = (await attempt.connection?.close()) ?? true
      if (attempt.connection?.exitVerdict.root === 'processless') {
        acquisitionError = new AgentSessionPreSpawnError(error)
      } else if (!closed) {
        acquisitionError = claudeAcquisitionCleanupError(attempt.connection, error)
      }
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    throw acquisitionError
  } finally {
    attempt.finish()
  }
}
