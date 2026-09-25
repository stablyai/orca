import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionPreSpawnError,
  stopAgentSessionProviderRoot,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { withAgentSessionCreatePhase } from '../observability/agent-session-instrumentation'
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
          providerHandle: {
            kind: 'claude' as const,
            sessionId: resumeSession.providerSessionId,
            leafUuid: resumeSession.turnEndLeafUuid
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
    acquisitions.assertCurrent(sessionId, attempt)
    return launch
  })
}
