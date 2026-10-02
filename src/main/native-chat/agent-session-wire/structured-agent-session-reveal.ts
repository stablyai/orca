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

import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { sessionTabListed } from './structured-agent-session-host-tabs'
import {
  adapterSupportsRecord,
  hostCanSettleRecord
} from './structured-agent-session-provider-support'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import {
  restoreStructuredAgentSessionsOnRestart,
  type StructuredAgentSessionReadRestoreDeps
} from './structured-agent-session-restart-restore'
import {
  createStructuredAgentSessionStartupState,
  type StructuredAgentSessionStartupState
} from './structured-agent-session-startup-state'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'
import {
  createStructuredAgentSessionPerChatFileCopyControl,
  type PerChatFileCopyStart
} from './structured-agent-session-per-chat-file-copy-control'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'
import {
  createReaderReconcile,
  reportEachFailureOnce
} from './structured-agent-session-restart-reconcile'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
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

/** The host's startup restore: reconcile, then seed and settle from the state stored beside each
 *  journal, then open in the background what that state cannot answer, and copy every chat still in
 *  an old per-chat file. Its lease bookkeeping is a reader's, which never fails a read or startup;
 *  startup shares it. */
export function createStructuredAgentSessionHostRestore(
  deps: StructuredAgentSessionHostDeps,
  wiring: Omit<
    StructuredAgentSessionReadRestoreDeps,
    'openDeps' | 'reconcile' | 'resolveRecovery' | 'isListed' | 'hasSession'
  > & {
    reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
    resolveRecovery: (sessionId: string) => Promise<unknown>
    /** Rows seeded from stored state, and the chats' sends in flight and provider frames. */
    chatStatus: Pick<StructuredAgentSessionClientDelivery, 'seedStatus' | 'chatWork'>
    sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  }
): {
  reconcileRestartLeases: () => Promise<void>
  restoreReadableSessions: (sessionIds?: readonly string[]) => Promise<void>
  startPerChatFileCopy: (input: PerChatFileCopyStart) => void
  stopPerChatFileCopy: () => Promise<void>
} & StructuredAgentSessionStartupState {
  const { reconcileLeases, resolveRecovery, chatStatus, sessions, ...wired } = wiring
  const rest = { ...wired, hasSession: (sessionId: string) => sessions.has(sessionId) }
  const failures = reportEachFailureOnce(deps.logger)
  const reconcile = createReaderReconcile(reconcileLeases, failures)
  const supportsRecord = (record: AgentSessionRecord) => adapterSupportsRecord(deps.adapter, record)
  const canSettle = (record: AgentSessionRecord | null): record is AgentSessionRecord =>
    hostCanSettleRecord(deps.adapter, record)
  const readRestore: StructuredAgentSessionReadRestoreDeps = {
    openDeps: deps,
    isListed: (sessionId) => sessionTabListed(deps.store, sessionId),
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
  }
  const restorer = new StructuredAgentSessionReadableRestorer({ ...readRestore, supportsRecord })
  const gate = new StructuredAgentSessionRestartRestoreGate()
  const startup = createStructuredAgentSessionStartupState({
    openDeps: deps,
    canSettle,
    seedStatus: chatStatus.seedStatus,
    resolveRecovery: readRestore.resolveRecovery,
    restoreListed: (records, resolveListedRecovery) =>
      restoreStructuredAgentSessionsOnRestart({
        ...readRestore,
        records,
        resolveRecovery: resolveListedRecovery
      }),
    recoveryBudgetMs: deps.startupRecoveryBudgetMs,
    serialize: rest.serialize,
    hasSession: rest.hasSession,
    isListed: readRestore.isListed,
    isDisposed: rest.isDisposed
  })
  // Calls of `restoreReadableSessions` still running: the derive pass at its front included.
  let readableRestores = 0
  const perChatFileCopy = createStructuredAgentSessionPerChatFileCopyControl({
    database: deps.journalDatabase,
    store: deps.store,
    serialize: rest.serialize,
    openJournal: (sessionId) => sessions.get(sessionId)?.journal,
    settleClosedChat: startup.settleClosedChat,
    chatWork: chatStatus.chatWork,
    canSettle,
    isHostChatWorkActive: () =>
      startup.isSettling() || readableRestores > 0 || restorer.isRestoring,
    isDisposed: rest.isDisposed,
    logger: deps.logger,
    now: () => deps.now?.() ?? Date.now(),
    appVersion:
      deps.appVersion ?? (hasAppEnvironment() ? getAppEnvironment().getVersion() : 'unknown')
  })
  return {
    reconcileRestartLeases: async () => {
      await reconcile('startup')
    },
    // The listed chats the tab list left to it: rows derived without an open first, then the rest.
    restoreReadableSessions: (sessionIds) => {
      readableRestores += 1
      return gate
        .run(async () =>
          restorer.restore(
            sessionIds === undefined ? undefined : await startup.deriveMissingStatuses(sessionIds)
          )
        )
        .finally(() => {
          readableRestores -= 1
        })
    },
    ...startup,
    startPerChatFileCopy: perChatFileCopy.start,
    stopPerChatFileCopy: perChatFileCopy.stop
  }
}
