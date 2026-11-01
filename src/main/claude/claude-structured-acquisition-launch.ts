import type { ClaudeNamingGeneration } from './claude-naming-generation'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  AgentSessionAcquisitionExitUnprovenError,
  launchPreparationFailure,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { stopAgentSessionProviderRoot } from '../native-chat/agent-session-wire/structured-agent-session-provider-exit-proof'
import { withAgentSessionCreatePhase } from '../observability/agent-session-instrumentation'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import {
  CLAUDE_APPLY_FLAG_SETTINGS_CONTROL,
  CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS,
  CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS,
  CLAUDE_EFFORT_FLAG
} from './claude-cli-flag-support'
import {
  claudeStructuredSpawnOptions,
  type ClaudeStructuredSpawnOptions
} from './claude-structured-spawn-options'
import {
  cancelClaudeAcquisitionAttempt,
  type ClaudeAcquisitionAttempt,
  type ClaudeAcquisitionRegistry,
  type ClaudeAcquireCallbacks,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps
} from './structured/claude-structured-session-state'
import {
  claudeCloseReport,
  closeClaudePublishedSessionForDeps
} from './claude-structured-session-close'

export type ClaudeAcquisitionLaunch = ClaudeStructuredLaunch & {
  savedOptions: Omit<ClaudeStructuredSpawnOptions, 'sdkOptions'>
}

export async function resolveClaudeAcquisitionLaunch(args: {
  input: StructuredAgentSessionAcquireInput
  deps: ClaudeStructuredSessionAdapterDeps
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  exits: Map<string, ClaudeSessionExit>
  callbacks: ClaudeAcquireCallbacks
  previous: ClaudeAcquisitionAttempt | undefined
  attempt: ClaudeAcquisitionAttempt
  naming?: ClaudeNamingGeneration
}): Promise<ClaudeAcquisitionLaunch> {
  const { input, deps, sessions, acquisitions, exits, callbacks, previous, attempt } = args
  const sessionId = input.identity.sessionId
  return withAgentSessionCreatePhase('auth_settle', input.recordPhase, async () => {
    if (
      previous &&
      claudeCloseReport(
        previous.connection,
        await cancelClaudeAcquisitionAttempt(previous),
        new Error(`claude acquisition for session ${sessionId} could not be stopped`)
      ) instanceof AgentSessionAcquisitionExitUnprovenError
    ) {
      acquisitions.restoreIfCurrent(sessionId, attempt, previous)
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`claude acquisition for session ${sessionId} could not be stopped`)
      )
    }
    acquisitions.assertCurrent(sessionId, attempt)
    let resumeSession = sessions.get(sessionId)
    const closed = await stopAgentSessionProviderRoot(() =>
      closeClaudePublishedSessionForDeps(sessions, sessionId, deps)
    )
    if (!closed) {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`claude session ${sessionId} could not be stopped`)
      )
    }
    const retainedExit = exits.get(sessionId)
    if (retainedExit) {
      const firstProof = retainedExit.closePromise ? await retainedExit.closePromise : false
      const proven = firstProof || (await retainedExit.connection.close().catch(() => false))
      const cleanupError = claudeCloseReport(retainedExit.connection, proven, retainedExit.error)
      if (cleanupError instanceof AgentSessionAcquisitionExitUnprovenError) {
        throw cleanupError
      }
      // Settle the old child before reusing its durable resume identity.
      await callbacks.settleExit(sessionId, retainedExit)
      resumeSession ??= retainedExit.session
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const launchIdentity = resumeSession
      ? {
          ...input.identity,
          providerHandle: claudeProviderHandle(
            resumeSession.providerSessionId,
            resumeSession.turnEndLeafUuid
          )
        }
      : input.identity
    const launch = await deps
      .resolveLaunch({
        identity: launchIdentity,
        spawnToken: input.spawnToken,
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {})
      })
      .catch((error: unknown) => {
        throw launchPreparationFailure(error)
      })
    acquisitions.assertCurrent(sessionId, attempt)
    // Saved effort waits out the version probe: a guess fails an old CLI's launch or defers effort.
    const effortFlag =
      input.options?.effort === undefined
        ? 'unknown'
        : await launch.cliFlag(CLAUDE_EFFORT_FLAG, CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS)
    const flagSettingsControl = await launch.cliFlag(
      CLAUDE_APPLY_FLAG_SETTINGS_CONTROL,
      CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS,
      false
    )
    acquisitions.assertCurrent(sessionId, attempt)
    const { sdkOptions, ...savedOptions } = claudeStructuredSpawnOptions({
      launch,
      saved: input.options,
      effortFlag,
      flagSettingsControl
    })
    return {
      ...launch,
      options: sdkOptions,
      savedOptions: { ...savedOptions, cliFlag: launch.cliFlag, flagSettingsControl }
    }
  })
}
