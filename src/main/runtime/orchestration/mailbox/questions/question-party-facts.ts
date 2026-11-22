// The facts one decision reads about each party, read fresh before it: a chat's journal now (never
// its last event), a terminal agent's hook phase now, and the mailboxes a delivery pass would hand
// it mail from. A fact that can't be read counts as "not running, no wake", which tells early.
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { QuestionPartyFacts } from './question-reconcile'
import { mailTakerKey, sessionMailTaker } from '../../db/messages/mail-taker'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession
} from '../../addressing/session-lineage/structured-session-lineage'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/agent-session/identity/orca-session-address-prefix'

export type QuestionPartyReads = {
  /** The chat running this lineage root's conversation now. */
  liveSession(root: string): string
  /** Its lead turn runs now; null when the chat isn't loaded here. */
  chatRunning(sessionId: string): Promise<boolean | null>
  /** The chat a structured delivery pass would send this mailbox's mail to now, if it can take it. */
  chatReceiving(mailbox: string): string | null
  chatHandingOver(mailbox: string): boolean
  /** A live terminal agent: its pty, panes, whether a person is being asked, and its hook phase. */
  terminal(
    handle: string
  ): { ptyId: string; paneKeys: readonly string[]; asking: boolean; working: boolean } | null
  terminalHandingOver(ptyId: string): boolean
}

function openDispatchMailboxes(db: OrchestrationDb, column: string, ids: string[]): string[] {
  return db.db
    .prepare(
      `SELECT id FROM dispatch_contexts WHERE status IN ('pending', 'dispatched')
       AND ${column} IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids)
    .flatMap(({ id }) => (typeof id === 'string' ? [`dispatch:${id}`] : []))
}

/** Reads every fresh fact the parties need, then answers the decision synchronously. */
export async function readQuestionPartyFacts(
  db: OrchestrationDb,
  reads: QuestionPartyReads,
  parties: Iterable<string>
): Promise<QuestionPartyFacts> {
  const running = new Map<string, boolean>()
  const mailboxes = new Map<string, readonly string[]>()
  const ptys = new Map<string, string>()
  for (const party of new Set(parties)) {
    if (party.startsWith('session:')) {
      const root = party.slice('session:'.length)
      const live = reads.liveSession(root)
      running.set(party, (await reads.chatRunning(live)) === true)
      const ids = [...new Set([root, live])]
      const runs = ids.flatMap((id) =>
        isOrcaSessionId(id)
          ? db
              .runsBoundToCoordinator({ orcaSessionId: id, paneKey: null, terminalHandle: null })
              .map((run) => `run:${run.id}`)
          : []
      )
      const all = [
        ...ids.map((id) => `${ORCA_SESSION_ADDRESS_PREFIX}${id}`),
        ...runs,
        ...openDispatchMailboxes(db, 'assignee_orca_session_id', ids)
      ]
      mailboxes.set(
        party,
        all.filter((mailbox) => reads.chatReceiving(mailbox) === live)
      )
    } else if (party.startsWith('terminal:')) {
      const handle = party.slice('terminal:'.length)
      const terminal = reads.terminal(handle)
      running.set(party, terminal?.working === true)
      if (terminal && !terminal.asking) {
        ptys.set(party, terminal.ptyId)
        mailboxes.set(party, [
          handle,
          ...terminal.paneKeys.flatMap((paneKey) =>
            db.runsBoundToPane(paneKey).map((run) => `run:${run.id}`)
          ),
          ...openDispatchMailboxes(db, 'assignee_handle', [handle])
        ])
      }
    }
  }
  return {
    running: (party) => running.get(party) ?? false,
    mailboxes: (party) => mailboxes.get(party) ?? [],
    handingOver: (party, mailbox) => {
      const ptyId = ptys.get(party)
      return ptyId ? reads.terminalHandingOver(ptyId) : reads.chatHandingOver(mailbox)
    },
    dispatchParty: (dispatchId) => dispatchParty(db, dispatchId)
  }
}

/** The taker key a Dispatch's worker takes mail as: its chat's lineage root, or its terminal. */
export function dispatchParty(db: OrchestrationDb, dispatchId: string): string | null {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (dispatch?.assignee_orca_session_id) {
    return mailTakerKey(sessionMailTaker(dispatch.assignee_orca_session_id))
  }
  return dispatch?.assignee_handle ? `terminal:${dispatch.assignee_handle}` : null
}

/** The chat running a lineage root's conversation now; the root itself when that can't be read. */
export function liveLineageSession(root: string): string {
  const running = resolveLineageRunningSession(readAgentSessionRecordStore(), root)
  return running.kind === 'here' ? running.sessionId : root
}
