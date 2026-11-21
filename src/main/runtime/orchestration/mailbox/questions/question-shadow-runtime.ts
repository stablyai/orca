// SPIKE, not for merge: runs the shadow question reconcile on every edge of a live runtime and logs
// each decision with the facts it used, so a live run can be compared with what really happened.
import { appendFileSync } from 'node:fs'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import { questionTakeListeners } from '../../db/messages/mail-taker'
import {
  chatRunningReaders,
  dispatchTransitionListeners,
  mailboxDrainListeners,
  structuredStateObservers
} from '../../db/messages/question-shadow-edges'
import { createChatOrcaSessionIdResolver } from '../../addressing/session-lineage/canonical-orca-session-id'
import {
  awaitingTakers,
  ensureShadowTable,
  reconcileQuestions,
  takersLinkedTo,
  type ReconcileHost
} from './question-reconcile'

type ShadowRuntime = {
  agentTransitions: { subscribe(listener: (change: AgentPaneChange) => void): () => void }
  getTerminalHandleForPaneKey(paneKey: string): string | null
}

const LOG = process.env.ORCA_QUESTION_SHADOW_LOG

function log(entry: Record<string, unknown>): void {
  if (LOG) {
    appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  }
}

export function installQuestionShadow(runtime: ShadowRuntime, db: OrchestrationDb): void {
  ensureShadowTable(db)
  const root = (sessionId: string): string => createChatOrcaSessionIdResolver()(sessionId)
  const sessions = new Map<string, { running: boolean; closed: boolean }>()
  const terminals = new Map<string, { phase: string; paneKey: string }>()

  const host: ReconcileHost = {
    running(party) {
      if (party.startsWith('session:')) {
        return sessions.get(party.slice('session:'.length))?.running ?? false
      }
      if (party.startsWith('terminal:')) {
        return terminals.get(party.slice('terminal:'.length))?.phase === 'working'
      }
      return false
    },
    canAttach(party) {
      // A chat's mail reopens it; a terminal must still have its pane.
      if (party.startsWith('session:')) {
        return true
      }
      if (party.startsWith('terminal:')) {
        const terminal = terminals.get(party.slice('terminal:'.length))
        return (
          terminal !== undefined && runtime.getTerminalHandleForPaneKey(terminal.paneKey) !== null
        )
      }
      return false
    },
    mailboxes(party) {
      if (party.startsWith('session:')) {
        const sessionId = party.slice('session:'.length)
        const runs = db.runsBoundToCoordinator({
          orcaSessionId: sessionId as never,
          paneKey: null
        } as never)
        return [`orca_session_id:${sessionId}`, ...runs.map((run) => `run:${run.id}`)]
      }
      if (party.startsWith('terminal:')) {
        const handle = party.slice('terminal:'.length)
        const paneKey = terminals.get(handle)?.paneKey ?? null
        const runs = paneKey ? db.runsBoundToPane(paneKey) : []
        return [handle, ...runs.map((run) => `run:${run.id}`)]
      }
      return []
    },
    dispatchParty(dispatchId) {
      const dispatch = db.getDispatchContextById(dispatchId)
      if (dispatch?.assignee_orca_session_id) {
        return `session:${root(dispatch.assignee_orca_session_id)}`
      }
      return dispatch?.assignee_handle ? `terminal:${dispatch.assignee_handle}` : null
    }
  }

  const refresh = async (sessionId: string): Promise<void> => {
    for (const read of chatRunningReaders) {
      const running = await read(sessionId).catch(() => null)
      if (running !== null) {
        const before = sessions.get(sessionId)
        sessions.set(sessionId, { running, closed: before?.closed ?? false })
        return
      }
    }
    // Not loaded: not running.
    sessions.set(sessionId, { running: false, closed: true })
  }
  const chains = new Map<string, Promise<void>>()
  // Serialized per taker; every chat the decision reads is read fresh first (design §1.3 step 3).
  const reconcile = (taker: string, edge: string): void => {
    const next = (chains.get(taker) ?? Promise.resolve()).then(async () => {
      const chats = new Set<string>(sessions.keys())
      if (taker.startsWith('session:')) {
        chats.add(taker.slice('session:'.length))
      }
      await Promise.all([...chats].map(refresh))
      reconcileNow(taker, edge)
    })
    chains.set(
      taker,
      next.catch(() => undefined)
    )
  }
  const reconcileNow = (taker: string, edge: string): void => {
    try {
      for (const decision of reconcileQuestions(db, host, taker)) {
        log({
          kind: 'would-notify',
          edge,
          messageId: decision.messageId,
          taker: decision.taker,
          questionKind: decision.kind,
          reason: decision.reason,
          facts: {
            running: host.running(taker),
            mailboxes: host.mailboxes(taker).map((mailbox) => ({
              mailbox,
              unread: db.db
                .prepare(
                  `SELECT id, type, delivered_at, created_at FROM messages
                   WHERE to_handle = ? AND read = 0 AND type != 'heartbeat' ORDER BY sequence DESC LIMIT 5`
                )
                .all(mailbox)
            })),
            recentToTaker: db.db
              .prepare(
                `SELECT id, type, read, delivered_at, created_at, to_handle FROM messages
                 WHERE type != 'heartbeat' ORDER BY sequence DESC LIMIT 6`
              )
              .all(),
            session: sessions.get(taker.replace(/^session:/, '')) ?? null,
            terminal: terminals.get(taker.replace(/^terminal:/, '')) ?? null
          }
        })
      }
    } catch (error) {
      log({ kind: 'error', edge, taker, error: String(error) })
    }
  }
  const reconcileLinked = (dispatchId: string, edge: string): void => {
    for (const taker of takersLinkedTo(db, dispatchId)) {
      reconcile(taker, edge)
    }
  }
  const dispatchesOf = (party: string): string[] =>
    (
      db.db
        .prepare(
          `SELECT id FROM dispatch_contexts WHERE status IN ('pending', 'dispatched')
           AND (assignee_orca_session_id = ? OR assignee_handle = ?)`
        )
        .all(party.replace(/^session:/, ''), party.replace(/^terminal:/, '')) as { id: string }[]
    ).map((row) => row.id)
  const partyChanged = (party: string, edge: string): void => {
    reconcile(party, edge)
    for (const dispatchId of dispatchesOf(party)) {
      reconcileLinked(dispatchId, `${edge}:linked`)
    }
  }

  questionTakeListeners.add((taker) => {
    log({ kind: 'edge', edge: 'E4-take', taker })
    reconcile(taker, 'E4-take')
  })
  structuredStateObservers.add(({ sessionId, running, closed }) => {
    const id = root(sessionId)
    const before = sessions.get(id)
    sessions.set(id, { running, closed })
    if (before?.running !== running || before?.closed !== closed) {
      log({ kind: 'edge', edge: closed ? 'E2-closed' : 'E1-chat', session: id, running })
    }
    partyChanged(`session:${id}`, closed ? 'E2-closed' : 'E1-chat')
  })
  runtime.agentTransitions.subscribe((change) => {
    const handle = runtime.getTerminalHandleForPaneKey(change.paneKey)
    if (!handle) {
      return
    }
    const phase = change.kind === 'moved' ? change.to : change.phase
    const before = terminals.get(handle)?.phase
    terminals.set(handle, { phase, paneKey: change.paneKey })
    if (before !== phase) {
      log({ kind: 'edge', edge: 'E3-pane', handle, phase })
    }
    partyChanged(`terminal:${handle}`, 'E3-pane')
  })
  dispatchTransitionListeners.add((dispatchId) => {
    log({
      kind: 'edge',
      edge: 'E5-dispatch',
      dispatchId,
      status: db.getDispatchContextById(dispatchId)?.status
    })
    reconcileLinked(dispatchId, 'E5-dispatch')
  })
  mailboxDrainListeners.add((mailboxes) => {
    for (const taker of awaitingTakers(db)) {
      if (host.mailboxes(taker).some((mailbox) => mailboxes.includes(mailbox))) {
        reconcile(taker, 'E12-drain')
      }
    }
  })
  // E9: everything still awaiting from before this start.
  queueMicrotask(() => {
    for (const taker of awaitingTakers(db)) {
      reconcile(taker, 'E9-open')
    }
  })
  log({ kind: 'installed' })
}
