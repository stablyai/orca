// For a test that needs a running agent now, the way production gives a chat one: a create at rest
// when the params name no record yet (a null fence), then the start its first message makes from
// the stored record, at the fence it reads there. Answers in the attach's shape for the fence and page.

import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { ensureStructuredAgentSessionAgent } from './structured-agent-session-agent-start'
import { attachStructuredAgentSessionUnderSerialize } from './structured-agent-session-attach-orchestration'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'

export async function attachForTests(
  host: StructuredAgentSessionHost,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  if (params.envelope.expectedRuntimeFence === null) {
    const created = await host.create(caller, params)
    if (!created.ok) {
      return created
    }
  }
  return startAgentForTests(host, sessionId)
}

/** The delivery loop's start, as its first message would make it. */
export function startAgentForTests(
  host: StructuredAgentSessionHost,
  sessionId: string
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { attachContext, serialize, sessions } = host.collaboratorsForTests()
  return serialize(sessionId, async () => {
    const started = await ensureStructuredAgentSessionAgent(attachContext(), sessionId)
    if (!started.ok) {
      return { ok: false, refusal: started.refusal }
    }
    const journal = sessions.get(sessionId)?.journal
    const fence = host.deps.store.getRecord(sessionId)?.lease.runtimeFence
    if (!journal || fence === undefined) {
      throw new Error(`attachForTests: ${sessionId} started without an open conversation`)
    }
    const tabId = host.deps.store.getSessionTabId(sessionId)
    return {
      ok: true,
      replayed: false,
      fence,
      cursor: journal.cursor(),
      value: {
        sessionId,
        fence,
        page: readAgentSessionHydrationPage(journal, fence),
        unconfirmedClientMessageIds: [],
        ...(tabId ? { tabId } : {})
      }
    }
  })
}

/**
 * The attach itself at the fence the caller names, for tests of its own guards (a stale fence, a
 * lease that still admits a writer, the drain before a replacement acquires). The production start
 * never presents those: it reads the record under the same serialize and skips a running agent.
 */
export function attachExistingForTests(
  host: StructuredAgentSessionHost,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { attachContext, serialize } = host.collaboratorsForTests()
  return serialize(params.envelope.sessionId, () =>
    attachStructuredAgentSessionUnderSerialize(attachContext(), caller.callerKey, params)
  )
}
