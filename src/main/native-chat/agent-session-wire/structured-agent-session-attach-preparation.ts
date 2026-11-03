import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import type { StructuredAgentSessionAttachOptions } from './structured-agent-session-attach-orchestration'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { openConversationForWrite } from './structured-agent-session-send-preparation'
import { withAgentSessionCreatePhase } from '../../observability/agent-session-instrumentation'

/** Ordinary recovery observes the old death proof before reservation can replace it. */
export async function prepareStructuredAgentSessionAttach(
  context: StructuredAgentSessionAttachContext,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions,
  lock: StructuredAgentSessionAttachLock
) {
  const sessionId = params.envelope.sessionId
  const recordPhase = options.recordPhase
  // Moving the fence requires rebaselining existing readers.
  let fenceBefore = context.sessions.has(sessionId)
    ? structuredAgentSessionConversationFence(context.deps.store, sessionId)
    : null
  const unreconciled = await withAgentSessionCreatePhase('reconcile_leases', recordPhase, () =>
    lock.wait(context.reconcileLeases(sessionId))
  )
  if (unreconciled) {
    return refuseAgentSessionMutation(unreconciled)
  }
  await withAgentSessionCreatePhase('resolve_recovery', recordPhase, () =>
    lock.wait(context.runtimeState.resolveRecovery(sessionId))
  )
  const probe = await withAgentSessionCreatePhase('probe_owner', recordPhase, () =>
    lock.wait(context.runtimeState.probeOwner(sessionId))
  )
  const { priorRecord, priorDeathEvidence, opened } = await lock.commit(async () => {
    const priorRecord = context.deps.store.getRecord(sessionId)
    const priorDeathEvidence = priorRecord?.lease.deathEvidence ?? null
    const opened =
      priorRecord && !context.sessions.has(sessionId)
        ? await openConversationForWrite(
            context.openConversation,
            params.envelope,
            context.deps.logger
          )
        : { ok: true as const }
    if (opened.ok && priorRecord && fenceBefore === null) {
      fenceBefore = structuredAgentSessionConversationFence(context.deps.store, sessionId)
    }
    return { priorRecord, priorDeathEvidence, opened }
  })
  if (!opened.ok) {
    return opened
  }
  const launchDirectory =
    !priorRecord && isFloatingWorkspaceId(params.location.workspaceId)
      ? (options.hostLaunchDirectory ??
        (await lock.wait(
          Promise.resolve(context.deps.resolveWorkspacePath?.(params.location.workspaceId))
        )))
      : undefined
  if (!priorRecord && isFloatingWorkspaceId(params.location.workspaceId) && !launchDirectory) {
    throw new Error('floating_agent_session_launch_directory_unavailable')
  }
  return { ok: true as const, fenceBefore, priorRecord, priorDeathEvidence, probe, launchDirectory }
}
