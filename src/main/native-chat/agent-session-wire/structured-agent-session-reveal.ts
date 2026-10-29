// Restore addressability from persisted identity without starting a child; failed journal opens retain a Retry tab.

import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { journalOpenRefusal } from '../agent-session-journal/journal-open-failure'
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

export async function revealStructuredAgentSession(
  deps: { store: Pick<StructuredAgentSessionHostDeps['store'], 'getConversation'> },
  sessionId: string,
  openConversation: (sessionId: string) => Promise<unknown>
): Promise<StructuredAgentSessionReveal> {
  const record = deps.store.getConversation(sessionId)
  if (!record) {
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
  }
  // Reveal grants no ownership, so contested/reconciling leases must remain inspectable.
  const openRefusal = await openConversation(sessionId).then(
    () => null,
    (error: unknown) => journalOpenRefusal(error)
  )
  return {
    sessionId,
    // Record-authoritative workspace prevents caller-directed tab publication.
    workspaceId: record.location.workspaceId,
    agent: record.provider,
    readable: openRefusal === null,
    ...(openRefusal ? { openRefusal } : {})
  }
}

/** Reconcile/recover then open readable journals; advisory reader bookkeeping never fails startup. */
export function createStructuredAgentSessionHostRestore(
  deps: StructuredAgentSessionHostDeps,
  wiring: Omit<
    ConstructorParameters<typeof StructuredAgentSessionReadableRestorer>[0],
    'openDeps' | 'reconcileAll' | 'reconcile' | 'resolveRecovery'
  > & {
    reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
    reconcileRestartLeases: () => Promise<AgentSessionWireRefusal | null>
    resolveRecovery: (sessionId: string) => Promise<unknown>
  }
): {
  reconcileRestartLeases: () => Promise<void>
  restoreReadableSessions: (sessionIds?: readonly string[]) => Promise<void>
} {
  const { reconcileLeases, reconcileRestartLeases, resolveRecovery, ...rest } = wiring
  const failures = reportEachFailureOnce(deps.logger)
  const reconcile = createReaderReconcile(reconcileLeases, failures)
  const reconcileStartup = createReaderReconcile(reconcileRestartLeases, failures)
  const restorer = new StructuredAgentSessionReadableRestorer({
    openDeps: deps,
    reconcileAll: reconcileStartup,
    reconcile,
    // Attach/send must retry recovery strictly before acting.
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
      await reconcileStartup()
    },
    restoreReadableSessions: (sessionIds) => gate.run(() => restorer.restore(sessionIds))
  }
}
