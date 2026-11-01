/** A terminal worker Orca closed keeps its conversation; open it as a chat on this host so any client can read and continue it. */

import { randomUUID } from 'node:crypto'
import { createStructuredAgentSessionId } from '../../../../../../shared/agent-session/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../../../../shared/agent-session/failures/agent-session-definitive-refusal'
import { AgentSessionRefusalError } from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { OrchestrationPartyLocation } from '../../../../../../shared/orchestration-caller-status'
import {
  CLI_CONVERSATION_ADOPTING_AGENTS,
  adoptsCliConversations,
  cliConversationCwdMatchesWorkspace,
  cliConversationNeedsRecordingCwd
} from '../../../../../../shared/structured-agent-cli-conversation-adoption'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { listStructuredProviderSessionOwnership } from '../../../../../native-chat/agent-session-wire/structured-provider-session-ownership'
import { findConflictingStructuredAdoption } from '../../../../../native-chat/structured-agent-session-history-adoption'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  readWorkerResumeSession,
  type WorkerResumeSession
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { RpcContext } from '../../../core'
import { createStructuredAgentSessionForWorktree } from '../../structured-agent-session-create'
import {
  ensureStructuredHostInstalled,
  requireStructuredHost,
  structuredCallerFor
} from '../../structured-agent-session-gate'

const opening = new Map<string, Promise<OrchestrationPartyLocation | null>>()

/** The chat this host already runs holding the worker's conversation; one must never be opened beside it. */
export function chatHoldingWorkerConversation(
  session: WorkerResumeSession
): { sessionId: string; workspaceId: string } | null {
  const agent = chatAgentFor(session)
  const host = getStructuredAgentSessionHost()
  if (!agent || !host) {
    return null
  }
  try {
    return findConflictingStructuredAdoption({
      agent,
      providerSessionId: session.providerSession.id,
      selfSessionId: '',
      ownership: listStructuredProviderSessionOwnership(host.deps.store.listConversations())
    })
  } catch {
    return null
  }
}

/** Null keeps the lookup's answer: the worker is not closed, or its conversation cannot become a chat here.
 *  Throws when a chat may have been created, so the caller retries rather than reporting the worker gone. */
export function openClosedWorkerChat(
  ctx: RpcContext,
  db: OrchestrationDb,
  handle: string
): Promise<OrchestrationPartyLocation | null> {
  const resource = db.getWorkerTerminalResourceByHandle(handle)
  if (!resource) {
    return Promise.resolve(null)
  }
  // Desktop and phone may click at once; both get the one chat.
  const inFlight = opening.get(resource.id)
  if (inFlight) {
    return inFlight
  }
  const open = (async (): Promise<OrchestrationPartyLocation | null> => {
    const { runtime } = ctx
    const worktreeId = resource.worktree_id
    const paneKey = resource.pane_key
    const session = readWorkerResumeSession(resource)
    const agent = session && chatAgentFor(session)
    if (
      !worktreeId ||
      !paneKey ||
      !session?.providerSession.transcriptPath ||
      !agent ||
      (resource.ownership_state !== 'released' && resource.release_state !== 'released') ||
      // An issued handle outlives its pane; only a connected PTY means the terminal is still there.
      runtime.getLiveTerminalPaneKey(handle) !== null
    ) {
      return null
    }
    try {
      await ensureStructuredHostInstalled(ctx, agent)
      requireStructuredHost(ctx, agent)
    } catch {
      return null
    }
    const held = chatHoldingWorkerConversation(session)
    if (held) {
      return { kind: 'chat', sessionId: held.sessionId, worktreeId: held.workspaceId }
    }
    const workspace = await runtime
      .showManagedTerminalWorkspace(`id:${worktreeId}`)
      .catch(() => null)
    if (
      !workspace ||
      (cliConversationNeedsRecordingCwd(agent) &&
        !cliConversationCwdMatchesWorkspace(session.providerSession.cwd, workspace.path))
    ) {
      return null
    }
    const created = await createStructuredAgentSessionForWorktree({
      runtime,
      ensureHost: async () => requireStructuredHost(ctx, agent),
      caller: structuredCallerFor(ctx),
      envelope: {
        sessionId: createStructuredAgentSessionId(agent, randomUUID),
        clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
        expectedRuntimeFence: null,
        // prepare supplies the host fingerprint; this id was host-minted.
        payloadFingerprint: ''
      },
      worktree: `id:${worktreeId}`,
      agent,
      // The closed pane's recorded transcript, read as a chat adopting a live pane reads it; WSL and SSH paths are refused there.
      resumeFrom: {
        providerSessionId: session.providerSession.id,
        cliSource: { workspaceId: worktreeId, paneKey }
      },
      structuredAgentCliSourceEvidence: {
        rows: [
          {
            state: 'done',
            prompt: '',
            agentType: session.agent,
            paneKey,
            worktreeId,
            connectionId: null,
            receivedAt: 0,
            stateStartedAt: 0,
            providerSession: session.providerSession
          }
        ]
      },
      // Reading needs no agent process; the next message starts it.
      atRest: true,
      activate: false
    })
    if (created.ok) {
      return { kind: 'chat', sessionId: created.value.sessionId, worktreeId }
    }
    if (isDefinitiveAgentSessionCreateRefusal(created.refusal.code)) {
      return null
    }
    throw new AgentSessionRefusalError(created.refusal)
  })().finally(() => opening.delete(resource.id))
  opening.set(resource.id, open)
  return open
}

/** Only a conversation recorded on this host, by an agent a chat can take over. */
function chatAgentFor(session: WorkerResumeSession) {
  return session.captureHostId === LOCAL_EXECUTION_HOST_ID && adoptsCliConversations(session.agent)
    ? CLI_CONVERSATION_ADOPTING_AGENTS[session.agent][0]
    : null
}
