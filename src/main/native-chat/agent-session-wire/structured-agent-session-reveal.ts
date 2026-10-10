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
import type { JournalWriteOptions } from '../agent-session-journal/journal-host-database'
import {
  BACKGROUND_WRITE,
  backgroundLeaseWrites,
  type BackgroundLeaseWrites
} from './structured-agent-session-background-writes'
import { isSqliteContentionFailure } from '../../sqlite/sqlite-read-failure'
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
import { scanStructuredAgentSessionsAtStartup } from './structured-agent-session-startup-settlement'
import {
  StructuredAgentSessionRetry,
  type StructuredAgentSessionRetryContext
} from './structured-agent-session-reconciliation-retry'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

/** Throws its refusal as the code itself. */
export async function revealStructuredAgentSession(
  deps: { store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'> },
  sessionId: string,
  openConversation: (sessionId: string) => Promise<unknown>
): Promise<StructuredAgentSessionReveal> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
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

/** The host's startup and its reconciliation: reconcile, then hand every chat to the host's retry
 *  in the background (no chat's tab or send waits on it), and the readable-restore sweep that
 *  resolves and opens each visible chat. Its lease bookkeeping is a reader's, which never fails a
 *  read or startup; startup shares it. */
export function createStructuredAgentSessionHostRestore(
  deps: StructuredAgentSessionHostDeps,
  wiring: Omit<
    ConstructorParameters<typeof StructuredAgentSessionReadableRestorer>[0],
    'openDeps' | 'reconcile' | 'resolveRecovery'
  > & {
    reconcileLeases: (
      sessionId: string | null,
      options?: JournalWriteOptions
    ) => Promise<AgentSessionWireRefusal | null>
    resolveRecovery: (sessionId: string, writes: BackgroundLeaseWrites) => Promise<unknown>
    startup: Pick<StructuredAgentSessionRetryContext, 'sessions'> & {
      tasks: Pick<StructuredAgentSessionTaskQueue, 'trackAttach' | 'busy'>
      clientDelivery: Pick<StructuredAgentSessionRetryContext, 'publishGenerationEnded'>
      queue: {
        sendForRetry: (sessionId: string) => Promise<'contended' | 'done'>
        abandon: (sessionId: string) => void
      }
    }
  }
): {
  reconcileRestartLeases: () => Promise<void>
  /** The startup scan the last reconcile began; resolved once every chat's first attempt ran. */
  startupSettled: () => Promise<void>
  restoreReadableSessions: (sessionIds?: readonly string[]) => Promise<void>
  reconciliation: StructuredAgentSessionRetry
} {
  const { reconcileLeases, resolveRecovery, startup, ...rest } = wiring
  const failures = reportEachFailureOnce(deps.logger)
  // Startup's and a restored read's bookkeeping, which neither waits on: another connection's lock
  // fails it at once, and the retry's round tries it again.
  const reconcile = createReaderReconcile(
    (sessionId) => reconcileLeases(sessionId, BACKGROUND_WRITE),
    failures
  )
  const recoveryWrites = backgroundLeaseWrites(deps.store)
  // The chats the restart restore was asked to make readable, the visible tabs: theirs is the one
  // latched recovery startup owes. A chat a reader opened behind them never is: a read stops no one.
  const restoreTargets = new Set<string>()
  let restoresAll = false
  const latchedTargets = () =>
    (restoresAll
      ? deps.store.listRecords().map((record) => record.sessionId)
      : [...restoreTargets]
    ).filter((sessionId) => deps.store.getRecord(sessionId)?.lease.handoffStage === 'recovering')
  const reconciliation = new StructuredAgentSessionRetry({
    deps,
    sessions: startup.sessions,
    now: () => deps.now?.() ?? Date.now(),
    serialize: rest.serialize,
    laneBusy: (sessionId) => startup.tasks.busy(sessionId),
    // Tracked like a start, so a quit waits for an attempt before it closes what it writes to.
    track: (operation) => startup.tasks.trackAttach(operation),
    publishGenerationEnded: (sessionId, options) =>
      startup.clientDelivery.publishGenerationEnded(sessionId, options),
    reconcileOwed: () =>
      deps.store.listRecords().some((record) => record.lease.unreconciled) ||
      latchedTargets().length > 0,
    reconcile: async () => {
      try {
        const refusal = await reconcileLeases(null, BACKGROUND_WRITE)
        if (refusal) {
          failures.report(refusal)
          return 'failed'
        }
        // The restore's own decision, wherever its reconcile or its write met a lock.
        for (const sessionId of latchedTargets()) {
          await resolveRecovery(sessionId, recoveryWrites)
        }
        failures.clear()
        return 'settled'
      } catch (error) {
        failures.report(error)
        return isSqliteContentionFailure(error) ? 'contended' : 'failed'
      }
    },
    sendQueued: (sessionId) => startup.queue.sendForRetry(sessionId),
    abandonSend: (sessionId) => startup.queue.abandon(sessionId)
  })
  let startupSettled: Promise<void> = Promise.resolve()
  const restorer = new StructuredAgentSessionReadableRestorer({
    openDeps: deps,
    reconcile,
    // The next attach or send resolves recovery again, strictly, before it acts.
    resolveRecovery: (sessionId) =>
      resolveRecovery(sessionId, recoveryWrites).then(
        () => true,
        (error: unknown) => {
          failures.report(error)
          // The retry's round decides it instead (`reconcileOwed`).
          reconciliation.signal(sessionId)
          return false
        }
      ),
    ...rest
  })
  const gate = new StructuredAgentSessionRestartRestoreGate()
  return {
    reconcileRestartLeases: async () => {
      await reconcile('startup')
      startupSettled = scanStructuredAgentSessionsAtStartup(deps.store, reconciliation)
    },
    startupSettled: () => startupSettled,
    restoreReadableSessions: (sessionIds) => {
      restoresAll ||= sessionIds === undefined
      sessionIds?.forEach((sessionId) => restoreTargets.add(sessionId))
      return gate.run(() => restorer.restore(sessionIds))
    },
    reconciliation
  }
}
