// One visit of the retry (`StructuredAgentSessionRetry`) to one owed chat: release repair,
// settlement and what an earlier process left (`runStructuredAgentSessionReconciliationPass`) in
// the chat's lane, then the queue's next send. Its outcome tells the round how to go on.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { isSqliteContentionFailure } from '../../sqlite/sqlite-read-failure'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  runStructuredAgentSessionReconciliationPass,
  type StructuredAgentSessionReconciliationDebts,
  type StructuredAgentSessionReconciliationPassContext
} from './structured-agent-session-reconciliation-pass'
import {
  loadStructuredAgentSessionForReconciliation,
  structuredAgentSessionJournalIsCurrent
} from './structured-agent-session-reconciliation-load'
import type { StructuredAgentSessionReconciliationSlotWaiter } from './structured-agent-session-reconciliation-slots'

export type StructuredAgentSessionRetryContext = StructuredAgentSessionReconciliationPassContext & {
  deps: StructuredAgentSessionReconciliationPassContext['deps']
  /** The chat's action lane, and whether anything holds it now. */
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  laneBusy: (sessionId: string) => boolean
  /** Lets a quit wait for a visit already writing. */
  track: <T>(operation: Promise<T>) => Promise<T>
  /** Publishes what is current now and wakes the queued-card drain. */
  publishGenerationEnded: (sessionId: string, options?: { restate?: boolean }) => void
  /** Whether the store-wide step owes anything: a lease unreconciled, or the restart restore's
   *  latched recovery its own write could not decide. */
  reconcileOwed: () => boolean
  /** That step, as background bookkeeping: whether it all settled, or why not. */
  reconcile: () => Promise<'settled' | 'contended' | 'failed'>
  /** The queue's automatic send of the chat's next card, inside the lane the visit holds, and an
   *  episode giving up on it (`StructuredAgentSessionQueuedMessageDrain.sendForRetry`, `.abandon`). */
  sendQueued: (sessionId: string) => Promise<'contended' | 'done'>
  abandonSend: (sessionId: string) => void
}

/** `again`: it wrote, or was signalled meanwhile, so the next round verifies nothing is left.
 *  `busy`: a person's operation held its lane, so it waits, owed, for a later round. */
export type StructuredAgentSessionVisit =
  | 'settled'
  | 'again'
  | 'parked'
  | 'failed'
  | 'contended'
  | 'busy'

/** A chat with something owed, until a visit finds nothing left. */
export type StructuredAgentSessionOwedChat = StructuredAgentSessionReconciliationSlotWaiter & {
  debts: StructuredAgentSessionReconciliationDebts
  /** A visit is owed now; false while only a recovering lease's proofs wait for its decision. */
  due: boolean
  /** The queue's automatic send met contention: it waits for the next round to wake it. */
  send?: true
  /** Signalled while its visit ran: the next round visits it again. */
  dirty: boolean
  attempted: (() => void)[]
  /** The visit's own read of the chat while nobody has it open, kept across rounds; closed when
   *  the chat settles, a reader opens it, or another handle wrote past it. */
  loaded?: StructuredAgentSessionHostSession
}

/** What a visit reads of the retry running it. */
export type StructuredAgentSessionVisitHost = {
  context: StructuredAgentSessionRetryContext
  disposed: () => boolean
  /** Where this process first opened each chat's journal (`StructuredAgentSessionRetry`). */
  firstOpened: Map<string, AgentJournalCursor>
  /** The chat leaves the owed set. */
  settle: (sessionId: string, chat: StructuredAgentSessionOwedChat) => 'settled'
  warn: (sessionId: string, error: unknown) => void
  /** The round's one-at-a-time turn for a chat's writes; null once the round stopped. */
  inTurn: <T>(run: () => Promise<T>) => Promise<T | null>
}

type Chat = StructuredAgentSessionOwedChat
type Visit = StructuredAgentSessionVisit

export async function visitStructuredAgentSessionOwedChat(
  host: StructuredAgentSessionVisitHost,
  sessionId: string,
  chat: Chat
): Promise<Visit | null> {
  const { context } = host
  try {
    const { store } = context.deps
    if (!store.getRecord(sessionId) || store.readOnly) {
      // The chat is gone, or nothing here may write: nothing of it is owed again.
      if (!store.getRecord(sessionId)) {
        host.firstOpened.delete(sessionId)
      }
      return host.settle(sessionId, chat)
    }
    if (!context.sessions.has(sessionId) && !chat.loaded) {
      const loaded = await loadStructuredAgentSessionForReconciliation(
        context.deps,
        sessionId,
        () => host.disposed() || context.sessions.has(sessionId)
      )
      if (loaded.kind === 'loaded') {
        chat.loaded = loaded.session
        noteStructuredAgentSessionOpened(host.firstOpened, sessionId, loaded.session.journal)
      } else if (loaded.kind === 'nothing') {
        return host.settle(sessionId, chat)
      }
    }
    // Its read stays loaded should the round stop before its turn: the next one writes, not replays.
    const visit = await host.inTurn(() => write(host, sessionId, chat))
    return visit === 'settled' ? host.settle(sessionId, chat) : visit
  } catch (error) {
    host.warn(sessionId, error)
    return isSqliteContentionFailure(error) ? 'contended' : 'failed'
  }
}

/** The chat's writes, in its lane: the pass, then (d) once nothing else of it is due, the send it
 *  owes, with the card named again. Never waits for a lane inside the round's turn: a person's
 *  operation holding it leaves the chat owed for a later round. */
async function write(
  host: StructuredAgentSessionVisitHost,
  sessionId: string,
  chat: Chat
): Promise<Visit> {
  const { context } = host
  if (context.laneBusy(sessionId)) {
    return 'busy'
  }
  return context.serialize(sessionId, async () => {
    const visit = await pass(host, sessionId, chat)
    if ((visit !== 'settled' && visit !== 'parked') || !chat.send) {
      return visit
    }
    if ((await context.sendQueued(sessionId)) === 'contended') {
      return 'contended'
    }
    delete chat.send
    context.publishGenerationEnded(sessionId)
    return visit
  })
}

/** Where this process first opened the chat, if this is the first. */
export function noteStructuredAgentSessionOpened(
  firstOpened: Map<string, AgentJournalCursor>,
  sessionId: string,
  journal: { openedAt: () => AgentJournalCursor }
): void {
  if (!firstOpened.has(sessionId)) {
    firstOpened.set(sessionId, journal.openedAt())
  }
}

/** Closes the visit's own read of the chat. */
export function dropStructuredAgentSessionLoaded(chat: Chat): void {
  const journal = chat.loaded?.journal
  chat.loaded = undefined
  void journal?.close()
}

/** The pass, inside the chat's lane, on the conversation a reader holds or the visit's own. */
async function pass(
  host: StructuredAgentSessionVisitHost,
  sessionId: string,
  chat: Chat
): Promise<Visit> {
  const session = sessionFor(host, sessionId, chat)
  if (host.disposed() || !session) {
    // Closed, or written by another handle, since this visit began: the next one reads it again.
    return host.disposed() ? 'settled' : 'failed'
  }
  chat.dirty = false
  const result = await runStructuredAgentSessionReconciliationPass(
    host.context,
    sessionId,
    session,
    chat.debts,
    host.firstOpened.get(sessionId) ?? session.journal.openedAt()
  )
  if (result.failed.length > 0) {
    host.warn(sessionId, result.failed[0])
    return result.failed.some(isSqliteContentionFailure) ? 'contended' : 'failed'
  }
  if (result.wrote || chat.dirty) {
    return 'again'
  }
  if (result.recovering && chat.debts.evidence) {
    // Its proofs wait for the recovery's decision, whose release signals again. An exit's account
    // judges only its own generation, which a later one may have replaced by then.
    delete chat.debts.exit
    chat.due = false
    return 'parked'
  }
  return 'settled'
}

function sessionFor(
  host: StructuredAgentSessionVisitHost,
  sessionId: string,
  chat: Chat
): Pick<StructuredAgentSessionHostSession, 'journal' | 'lastEndedChild'> | undefined {
  const open = host.context.sessions.get(sessionId)
  const { loaded } = chat
  if (
    open ||
    (loaded &&
      !structuredAgentSessionJournalIsCurrent(host.context.deps, sessionId, loaded.journal))
  ) {
    dropStructuredAgentSessionLoaded(chat)
    return open
  }
  return loaded
}
