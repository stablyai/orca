/** A terminal worker Orca closed keeps its conversation; open it as a chat on this host so any client can read and continue it. */

import { randomUUID } from 'node:crypto'
import { createStructuredAgentSessionId } from '../../../../../../shared/agent-session/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { OrchestrationPartyLocation } from '../../../../../../shared/orchestration-caller-status'
import {
  CLI_CONVERSATION_ADOPTING_AGENTS,
  adoptsCliConversations,
  cliConversationCwdMatchesWorkspace,
  cliConversationNeedsRecordingCwd
} from '../../../../../../shared/structured-agent-cli-conversation-adoption'
import { isWslUncPath } from '../../../../../../shared/wsl-paths'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionCaller } from '../../../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import { listStructuredProviderSessionOwnership } from '../../../../../native-chat/agent-session-wire/structured-provider-session-ownership'
import { findConflictingStructuredAdoption } from '../../../../../native-chat/structured-agent-session-history-adoption'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  readWorkerResumeSession,
  type WorkerResumeSession
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { createStructuredAgentSessionForWorktree } from '../../structured-agent-session-create'

type ClosedWorkerChatRuntime = Pick<
  OrcaRuntimeService,
  'showTerminal' | 'showManagedTerminalWorkspace' | 'ensureStructuredAgentSessionHost'
> &
  Parameters<typeof createStructuredAgentSessionForWorktree>[0]['runtime']

const opening = new Map<string, Promise<OrchestrationPartyLocation | null>>()

/** The chat on this host holding the worker's conversation now; one must never be opened beside it. */
export async function chatHoldingWorkerConversation(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  session: WorkerResumeSession
): Promise<{ sessionId: string; workspaceId: string } | null> {
  const agent = chatAgentFor(session)
  if (!agent) {
    return null
  }
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  return host
    ? findConflictingStructuredAdoption({
        agent,
        providerSessionId: session.providerSession.id,
        selfSessionId: '',
        ownership: listStructuredProviderSessionOwnership(host.deps.store.listConversations())
      })
    : null
}

/** Null keeps the terminal answer: the worker is not closed, or its conversation cannot become a chat here. */
export function openClosedWorkerChat(
  runtime: ClosedWorkerChatRuntime,
  db: OrchestrationDb,
  handle: string,
  caller: StructuredAgentSessionCaller
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
  const open = (async () => {
    const worktreeId = resource.worktree_id
    const session = readWorkerResumeSession(resource)
    const agent = session && chatAgentFor(session)
    if (
      !worktreeId ||
      !session ||
      !agent ||
      (resource.ownership_state !== 'released' && resource.release_state !== 'released') ||
      (await runtime.showTerminal(handle).then(
        () => true,
        () => false
      ))
    ) {
      return null
    }
    const held = await chatHoldingWorkerConversation(runtime, session)
    if (held) {
      return { kind: 'chat' as const, sessionId: held.sessionId, worktreeId: held.workspaceId }
    }
    const workspace = await runtime
      .showManagedTerminalWorkspace(`id:${worktreeId}`)
      .catch(() => null)
    const { cwd, transcriptPath } = session.providerSession
    if (
      !workspace ||
      (transcriptPath && isWslUncPath(transcriptPath)) ||
      (cliConversationNeedsRecordingCwd(agent) &&
        !cliConversationCwdMatchesWorkspace(cwd, workspace.path))
    ) {
      return null
    }
    const created = await createStructuredAgentSessionForWorktree({
      runtime,
      ensureHost: async () => {
        await runtime.ensureStructuredAgentSessionHost()
        const host = getStructuredAgentSessionHost()
        if (!host) {
          throw new Error('structured_agent_session_unsupported')
        }
        return host
      },
      caller,
      envelope: {
        sessionId: createStructuredAgentSessionId(agent, randomUUID),
        clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
        expectedRuntimeFence: null,
        // prepare supplies the host fingerprint; this id was host-minted.
        payloadFingerprint: ''
      },
      worktree: `id:${worktreeId}`,
      agent,
      resumeFrom: { providerSessionId: session.providerSession.id },
      // Reading needs no agent process; the next message starts it.
      atRest: true,
      activate: false
    })
    return created.ok
      ? { kind: 'chat' as const, sessionId: created.value.sessionId, worktreeId }
      : null
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
