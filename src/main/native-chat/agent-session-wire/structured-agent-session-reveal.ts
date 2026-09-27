// Making a persisted chat addressable again, for a surface that can no longer see it.
//
// `close` keeps the record and the journal on disk precisely so a session can be attached again;
// what it does not keep is the tab, and a client drops every unpublished `agent-session` tab on
// each session-tabs sync. So a chat the user closed — or one this process has not opened since
// launch — is reachable in Agent Session History by id and by nothing else. This is the lookup that
// turns that id back into something a client can publish.
//
// It is deliberately the whole of what reveal does on the host. It starts no provider child: only
// a send does. And a journal it cannot open is not a refusal — the chat shows that failure with a
// Retry, so the tab is worth publishing either way.

import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionReveal
} from './structured-agent-session-host-types'

/** Throws its refusal as the code itself. */
export async function revealStructuredAgentSession(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'adapter'>,
  sessionId: string,
  openConversation: (sessionId: string) => Promise<unknown>
): Promise<StructuredAgentSessionReveal> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  if (!adapterSupportsRecord(deps.adapter, record)) {
    throw new Error('structured_agent_session_unsupported')
  }
  // Lease state is not consulted on purpose: this neither claims the lease nor spawns a child, so a
  // contested or reconciling chat still reveals and the send that follows adjudicates it. Refusing
  // here would hide the one view of a session a user needs when its ownership is in doubt.
  const readable = await openConversation(sessionId).then(
    () => true,
    () => false
  )
  return {
    sessionId,
    // From the record, never from a caller: a client that knows only a session id must not be able
    // to aim the tab publication at another workspace.
    workspaceId: record.location.workspaceId,
    agent: record.provider,
    readable
  }
}
