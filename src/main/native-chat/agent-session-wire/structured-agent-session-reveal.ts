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

import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { journalOpenRefusal } from '../agent-session-journal/journal-open-failure'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'
import {
  createReaderReconcile,
  reportEachFailureOnce
} from './structured-agent-session-restart-reconcile'
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
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
  }
  if (!adapterSupportsRecord(deps.adapter, record)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  // Lease state is not consulted on purpose: this neither claims the lease nor spawns a child, so a
  // contested or reconciling chat still reveals and the send that follows adjudicates it. Refusing
  // here would hide the one view of a session a user needs when its ownership is in doubt.
  const openRefusal = await openConversation(sessionId).then(
    () => null,
    (error: unknown) => journalOpenRefusal(error)
  )
  return {
    sessionId,
    // From the record, never from a caller: a client that knows only a session id must not be able
    // to aim the tab publication at another workspace.
    workspaceId: record.location.workspaceId,
    agent: record.provider,
    readable: openRefusal === null,
    ...(openRefusal ? { openRefusal } : {})
  }
}

/** The host's startup readable-restore sweep: reconcile, resolve, then open each chat's journal.
 *  Its lease bookkeeping is a reader's, which never fails a read or startup; startup shares it. */
export function createStructuredAgentSessionHostRestore(
  deps: StructuredAgentSessionHostDeps,
  wiring: Omit<
    ConstructorParameters<typeof StructuredAgentSessionReadableRestorer>[0],
    'openDeps' | 'supportsRecord' | 'reconcile' | 'resolveRecovery'
  > & {
    reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
    resolveRecovery: (sessionId: string) => Promise<unknown>
  }
): {
  reconcileRestartLeases: () => Promise<void>
  restoreReadableSessions: (sessionIds?: readonly string[]) => Promise<void>
} {
  const { reconcileLeases, resolveRecovery, ...rest } = wiring
  const failures = reportEachFailureOnce(deps.logger)
  const reconcile = createReaderReconcile(reconcileLeases, failures)
  const restorer = new StructuredAgentSessionReadableRestorer({
    openDeps: deps,
    supportsRecord: (record) => adapterSupportsRecord(deps.adapter, record),
    reconcile,
    // The next attach or send resolves recovery again, strictly, before it acts.
    resolveRecovery: (sessionId) =>
      resolveRecovery(sessionId).then(
        () => true,
        (error: unknown) => {
          failures.report(error)
          return false
        }
      ),
    ...rest
  })
  const gate = new StructuredAgentSessionRestartRestoreGate()
  return {
    reconcileRestartLeases: async () => {
      await reconcile('startup')
    },
    restoreReadableSessions: (sessionIds) => gate.run(() => restorer.restore(sessionIds))
  }
}
