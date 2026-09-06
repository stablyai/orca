// Making a persisted chat addressable again, for a surface that can no longer see it.
//
// `close` keeps the record and the journal on disk precisely so a session can be attached again;
// what it does not keep is the tab, and a client drops every unpublished `agent-session` tab on
// each session-tabs sync. So a chat the user closed — or one this process has not opened since
// launch — is reachable in Agent Session History by id and by nothing else. This is the lookup that
// turns that id back into something a client can publish.
//
// It is deliberately the whole of what reveal does on the host. It takes no hold: a provider child
// exists because a surface asked for one, and the chat pane asks when it binds. And a journal it
// cannot read is not a refusal — a chat whose journal predates the SQLite store restores to nothing
// here, yet attach still recovers it, so the tab is worth publishing either way.

import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionReveal
} from './structured-agent-session-host-types'

/** Throws its refusal as the code itself, matching `resumeHeldStructuredAgentSession`. */
export async function revealStructuredAgentSession(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'adapter'>,
  sessionId: string,
  hasSession: (sessionId: string) => boolean,
  restoreReadable: (sessionId: string) => Promise<boolean>
): Promise<StructuredAgentSessionReveal> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  if (!adapterSupportsRecord(deps.adapter, record)) {
    throw new Error('structured_agent_session_unsupported')
  }
  // Lease state is not consulted on purpose: this neither claims the lease nor spawns a child, so a
  // contested or reconciling chat still reveals and the hold that follows adjudicates it. Refusing
  // here would hide the one view of a session a user needs when its ownership is in doubt.
  const readable = hasSession(sessionId) || (await restoreReadable(sessionId))
  return {
    sessionId,
    // From the record, never from a caller: a client that knows only a session id must not be able
    // to aim the tab publication at another workspace.
    workspaceId: record.location.workspaceId,
    agent: record.provider,
    readable
  }
}

/**
 * The host's whole readable-restore surface: the startup sweep and the on-demand reveal.
 *
 * Bundled the way the handoff and lifetime collaborators are, because the two share the restorer
 * and differ only in who is asking — startup, once, for everything; a surface, later, for one.
 */
export function createStructuredAgentSessionHostRestore(
  deps: StructuredAgentSessionHostDeps,
  wiring: Omit<
    ConstructorParameters<typeof StructuredAgentSessionReadableRestorer>[0],
    'store' | 'journalRoot' | 'supportsRecord'
  >
): {
  restoreReadableSessions: (sessionIds?: readonly string[]) => Promise<void>
  revealSession: (sessionId: string) => Promise<StructuredAgentSessionReveal>
} {
  const restorer = new StructuredAgentSessionReadableRestorer({
    store: deps.store,
    journalRoot: deps.journalRoot,
    supportsRecord: (record) => adapterSupportsRecord(deps.adapter, record),
    ...wiring
  })
  const gate = new StructuredAgentSessionRestartRestoreGate()
  return {
    restoreReadableSessions: (sessionIds) => gate.run(() => restorer.restore(sessionIds)),
    revealSession: (sessionId) =>
      revealStructuredAgentSession(deps, sessionId, wiring.hasSession, (id) =>
        restorer.restoreOne(id)
      )
  }
}
