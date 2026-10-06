import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { CLAUDE_SPAWN_TOKEN_ENV } from './claude-structured-owner-identity'
import type { ClaudeStreamJsonLaunch } from './claude-stream-json-connection'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { stopAgentSessionProviderRoot } from '../native-chat/agent-session-wire/structured-agent-session-provider-exit-proof'
import { withAgentSessionCreatePhase } from '../observability/agent-session-instrumentation'
import {
  isClaudeAuthSwitchInProgress,
  reserveClaudeCredentialOwner
} from '../claude-accounts/live-pty-gate'
import { CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE } from '../claude-accounts/environment'

export function assertClaudeAcquisitionAuthReady(): void {
  if (isClaudeAuthSwitchInProgress()) {
    throw new AgentSessionPreSpawnError(new Error(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE), {
      reason: 'accountSwitchInProgress'
    })
  }
}
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import {
  cancelClaudeAcquisitionAttempt,
  type ClaudeAcquisitionAttempt,
  type ClaudeAcquisitionRegistry,
  type ClaudeAcquireCallbacks,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'
import {
  claudeAcquisitionCleanupError,
  closeClaudePublishedSessionForDeps
} from './claude-structured-session-close'

export async function resolveClaudeAcquisitionLaunch(args: {
  input: StructuredAgentSessionAcquireInput
  deps: ClaudeStructuredSessionAdapterDeps
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  exits: Map<string, ClaudeSessionExit>
  callbacks: ClaudeAcquireCallbacks
  previous: ClaudeAcquisitionAttempt | undefined
  attempt: ClaudeAcquisitionAttempt
}): Promise<ClaudeStructuredLaunch> {
  const { input, deps, sessions, acquisitions, exits, callbacks, previous, attempt } = args
  const sessionId = input.identity.sessionId
  return withAgentSessionCreatePhase('auth_settle', input.recordPhase, async () => {
    if (previous && !(await cancelClaudeAcquisitionAttempt(previous))) {
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
      if (!proven) {
        const cleanupError = claudeAcquisitionCleanupError(
          retainedExit.connection,
          retainedExit.error
        )
        // A proven root exit is what released the lease, so it cannot also refuse the next root;
        // only an exit this host cannot vouch for still blocks the start.
        if (cleanupError instanceof AgentSessionAcquisitionExitUnprovenError) {
          throw cleanupError
        }
      }
      // The superseded child must settle before its durable resume identity is reused.
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
      .resolveLaunch({ identity: launchIdentity })
      .catch((error: unknown) => {
        throw error instanceof AgentSessionPreSpawnError
          ? error
          : new AgentSessionPreSpawnError(error)
      })
    try {
      acquisitions.assertCurrent(sessionId, attempt)
      return launch
    } catch (error) {
      launch.release?.()
      throw error
    }
  })
}

/** Common profile preparation owns its isolated reservation; ordinary launches retain the existing gate. */
export function reserveClaudeAcquisitionPreparation(
  deps: ClaudeStructuredSessionAdapterDeps,
  sessionId: string
) {
  const releaseCredentialOwner = deps.hasProfileBinding?.(sessionId)
    ? () => {}
    : reserveClaudeCredentialOwner(false)
  let releaseProfile: (() => void) | undefined
  return {
    capture: (launch: ClaudeStructuredLaunch) => {
      releaseProfile = launch.release
    },
    release: () => {
      releaseProfile?.()
      releaseCredentialOwner()
    }
  }
}

export function buildClaudeAcquisitionChildLaunch(
  launch: ClaudeStructuredLaunch,
  spawnToken: string
): ClaudeStreamJsonLaunch {
  return {
    pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
    isolatedCredentials: launch.isolatedCredentials,
    envToDelete: launch.envToDelete,
    options: launch.options,
    cwd: launch.cwd,
    env: {
      ...launch.env,
      [CLAUDE_SPAWN_TOKEN_ENV]: spawnToken,
      // Compared against what the child would otherwise inherit, so the record's
      // account home still wins over a diverging overlay without a needless pin.
      ...claudeConfigDirEnvPatch(launch.claudeConfigDir, launch.env ? { env: launch.env } : {})
    }
  }
}
