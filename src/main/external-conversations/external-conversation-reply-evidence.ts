import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalConnectorClaim,
  AgentJournalConnectorDelivery
} from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import type {
  JournalConnectorReplyCut,
  JournalConnectorReplyExpect,
  JournalConnectorReplyOutcome,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { agentTurnVerdict } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { ConnectorFailure } from '../../shared/connectors/connector-cloud-contract'
import type { ReplyRecoveryChat } from './external-conversation-reply-recovery'
import { DISPATCH_DOUBT_PROVIDER_EXITED } from '../native-chat/agent-session-journal/projection/journal-dispatch-doubt-reasons'

// What the journal proves about reply outbox rows (Phase 1): which cut a row is in, what its claim's
// continuation became, and the verdict a turn carries, derived ones included.

type Unfilled = JournalConnectorReplyRow

export type ReplyRecoveryVerdict = {
  outcome: JournalConnectorReplyOutcome
  failure?: ConnectorFailure
}

// The machine lost track of the request across a restart: it may have finished (Phase 1 §1.8).
export const UNCONFIRMED: ConnectorFailure = { category: 'unconfirmed' }

export const keyOf = (row: Unfilled) => ({ account: row.account, deliveryId: row.deliveryId })

// A write expects the row as it was read: open, owed by its cut, or held by its claim.
export const expectOf = (row: Unfilled): { expect?: JournalConnectorReplyExpect } =>
  row.claimMessageId !== undefined
    ? { expect: { claimMessageId: row.claimMessageId } }
    : row.cut
      ? { expect: { cutTurnId: row.cut.turnId } }
      : {}

// A turn's verdict, derived ones (interruption, unconfirmed) included.
export const turnVerdictOf = (turn: AgentJournalRenderItem) => {
  const lifecycle = readAgentJournalTurn(turn.body)
  return lifecycle
    ? agentTurnVerdict({
        state: lifecycle.state,
        outcome: readAgentJournalTurnOutcome(lifecycle)
      })
    : null
}

/** The journal around the rows, and what it proves about each (Phase 1 §1.3, §1.7). */
export async function readReplyEvidence(
  chat: Pick<ReplyRecoveryChat, 'journalReads'>,
  sessionId: string,
  rows: readonly Unfilled[],
  rejectionOf: (submission: AgentJournalSubmission) => { failure?: ConnectorFailure }
) {
  // From the rows' own sends (or the queued cards they carried, or the continuations that claimed
  // them) to the head, without tool output: the whole journal can be hundreds of MB.
  const { snapshot } = await (
    await chat.journalReads(sessionId)
  ).operationWindow({
    operationIds: [
      ...new Set(rows.flatMap((row) => [row.messageId, ...(row.claimMessageId ?? [])]))
    ],
    withoutToolOutput: true
  })
  // A row's message by the stamp it carries: a queued card's handed-off message carries it too.
  const messageOf = (row: Unfilled) =>
    snapshot.items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.connectorDelivery?.account === row.account &&
        (item.body.connectorDelivery.deliveryId === row.deliveryId ||
          item.body.connectorDelivery.carried?.includes(row.deliveryId) === true)
    )
  const submissionByKey = (key: string | undefined) =>
    key === undefined
      ? undefined
      : snapshot.submissions.find(
          (candidate) => agentJournalSubmissionKey(candidate.clientMessageId) === key
        )
  const submissionOf = (row: Unfilled) => submissionByKey(messageOf(row)?.itemId)
  const turnRowOf = (cutTurnId: string) =>
    snapshot.items.findLast(
      (item) => readAgentJournalTurn(item.body)?.turnId === cutTurnId || item.itemId === cutTurnId
    )
  const turnOpenedBy = (messageId: string) => {
    const key = agentJournalSubmissionKey(messageId)
    const row = snapshot.items.findLast(
      (item) => readAgentJournalTurn(item.body)?.userItemId === key
    )
    const turn = row && readAgentJournalTurn(row.body)
    return row && turn ? { row, turnId: turn.turnId, verdict: turnVerdictOf(row) } : undefined
  }
  // Phase 1 §1.3: its turn's opener, a send answered into that turn, or the cut send itself (and
  // the sends still pending beside it when the cut is a send's, N-E).
  const inCut = (row: Unfilled, cutTurnId: string): boolean => {
    const message = messageOf(row)
    const submission = submissionOf(row)
    const turnRow = turnRowOf(cutTurnId)
    const turn = turnRow && readAgentJournalTurn(turnRow.body)
    if (turnRow && turn) {
      return (
        (message !== undefined && turn.userItemId === message.itemId) ||
        submission?.answeredInTurn?.turnItemId === turnRow.itemId
      )
    }
    return (
      submission !== undefined &&
      !submission.answeredInTurn &&
      (submission.clientMessageId === cutTurnId ||
        submission.dispatchState === 'pending' ||
        submission.dispatchState === 'unknown')
    )
  }
  // A turn cut's opener, or for a submission cut (a send no turn took yet) that send's own message.
  const cutOpener = (cutTurnId: string) => {
    const turn = readAgentJournalTurn(turnRowOf(cutTurnId)?.body)
    const opener = turn?.userItemId ?? agentJournalSubmissionKey(cutTurnId)
    return snapshot.items.find((item) => item.itemId === opener)
  }
  // A claimed row's end, read from the continuation that claimed it (Phase 1 §1.7); null waits.
  const claimVerdict = (claimMessageId: string): ReplyRecoveryVerdict | null => {
    const turn = turnOpenedBy(claimMessageId)
    if (turn) {
      // A verdict fills through the turn's own fill; one cut again with no continuation is told.
      return turn.verdict === 'interruption' || turn.verdict === 'unconfirmed'
        ? { outcome: 'interrupted' }
        : null
    }
    const submission = submissionByKey(agentJournalSubmissionKey(claimMessageId))
    if (submission?.dispatchState === 'rejected') {
      return { outcome: 'failed', ...rejectionOf(submission) }
    }
    if (submission?.dispatchState === 'unknown' && submission.recovered === true) {
      return { outcome: 'interrupted', failure: UNCONFIRMED }
    }
    return null
  }
  return {
    snapshot,
    messageOf,
    submissionOf,
    inCut,
    turnOpenedBy,
    cutOpener,
    claimVerdict,
    // Only turns that could have answered a row still unfilled.
    turns: () => {
      const placed = rows.map((row) => messageOf(row)?.sequence ?? 0).filter((at) => at > 0)
      const since = placed.length > 0 ? Math.min(...placed) : Number.POSITIVE_INFINITY
      return snapshot.items.filter(
        (item) => item.sequence >= since && readAgentJournalTurn(item.body)
      )
    }
  }
}

/** A continuation about to be sent for a cut (Phase 1 §1.4): the open rows that cut proves its own,
 *  and the rows an earlier continuation this cut cut again held, become the cut's; the claim names
 *  it and the deliveries it answers, oldest first (a chain keeps its first cut's). None owed: none. */
export async function claimCut(
  journal: ConnectorReplyCutJournal,
  chat: Pick<ReplyRecoveryChat, 'journalReads'>,
  sessionId: string,
  cut: JournalConnectorReplyCut,
  rejectionOf: (submission: AgentJournalSubmission) => { failure?: ConnectorFailure }
): Promise<AgentJournalConnectorClaim | undefined> {
  const unfilled = (await journal.read(sessionId)).filter((row) => !row.fill)
  if (unfilled.length === 0) {
    return undefined
  }
  const view = await readReplyEvidence(chat, sessionId, unfilled, rejectionOf)
  const members = unfilled.filter(
    (row) => !row.cut && row.claimMessageId === undefined && view.inCut(row, cut.turnId)
  )
  if (members.length > 0) {
    await journal.cut({ keys: members.map(keyOf), cut })
  }
  // A claim is cut again when its continuation's turn is the cut, or, cut before any turn took it,
  // when the continuation is the cut send itself (A6).
  for (const claim of new Set(unfilled.flatMap((row) => row.claimMessageId ?? []))) {
    if (claim === cut.turnId || view.turnOpenedBy(claim)?.turnId === cut.turnId) {
      await journal.recut(claim, cut)
    }
  }
  const owed = (await journal.read(sessionId)).filter(
    (row) => !row.fill && row.cut?.turnId === cut.turnId && row.claimMessageId === undefined
  )
  if (owed.length === 0) {
    return undefined
  }
  // A cut continuation's own claim already names its deliveries in their order.
  const chained = view.cutOpener(cut.turnId)
  const origin =
    chained?.body.kind === 'message' && chained.body.connectorClaim
      ? chained.body.connectorClaim.origin
      : owed
          .map((row) => ({ row, at: view.messageOf(row)?.sequence ?? Number.MAX_SAFE_INTEGER }))
          .sort((a, b) => a.at - b.at)
          .map(({ row }) => ({
            account: row.account,
            conversation: row.conversation,
            deliveryId: row.deliveryId
          }))
  return { cutTurnId: cut.turnId, cutKind: cut.kind, origin }
}

const names = (stamps: readonly AgentJournalConnectorDelivery[]) => (row: Unfilled) =>
  stamps.some(
    (stamp) =>
      stamp.account === row.account &&
      (stamp.deliveryId === row.deliveryId || stamp.carried?.includes(row.deliveryId) === true)
  )

/** Each row by the journal's own evidence; nothing by position (Phase 1 §1.8). cut / unresolved:
 *  the stamps of cut turns and of turns with no verdict yet; settled: this start's continuations
 *  of restart cuts settled. null leaves the row owed. */
export function rowVerdict(
  row: Unfilled,
  facts: {
    view: Awaited<ReturnType<typeof readReplyEvidence>>
    cut: readonly AgentJournalConnectorDelivery[]
    unresolved: readonly AgentJournalConnectorDelivery[]
    settled: boolean
    /** Usage-limit cuts whose scheduler will send no continue (disposition ended). */
    endedCuts: ReadonlySet<string>
    idle: boolean
    lastEnded: number
    /** When this host process started: a send accepted before it was cut off by a restart. */
    startedAt: number
    rejectionOf: (submission: AgentJournalSubmission) => { failure?: ConnectorFailure }
  }
): ReplyRecoveryVerdict | null {
  const { view, cut, unresolved, settled, endedCuts, idle, lastEnded, startedAt, rejectionOf } =
    facts
  if (row.claimMessageId !== undefined) {
    return settled ? view.claimVerdict(row.claimMessageId) : null
  }
  if (row.cut?.kind === 'usage_limit') {
    // Its scheduler's to close: once no continue will come, it fails with the limit it hit.
    return endedCuts.has(row.cut.turnId)
      ? { outcome: 'failed', ...(row.cutFailure ? { failure: row.cutFailure } : {}) }
      : null
  }
  if (row.cut) {
    return settled ? { outcome: 'interrupted' } : null
  }
  if (names(cut)(row)) {
    return settled ? { outcome: 'interrupted' } : null
  }
  if (names(unresolved)(row)) {
    return null
  }
  const submission = view.submissionOf(row)
  if (submission && !submission.answeredInTurn) {
    if (submission.dispatchState === 'rejected') {
      return { outcome: 'failed', ...rejectionOf(submission) }
    }
    if (
      submission.dispatchState === 'unknown' &&
      submission.recovered === true &&
      submission.reason === DISPATCH_DOUBT_PROVIDER_EXITED
    ) {
      return { outcome: 'interrupted' }
    }
  }
  // Delivered, no turn proves it took it, and a turn after it ended with the chat idle. Accepted
  // before a restart: the machine lost track of it. Accepted in this process: a send handed into
  // a running turn (Claude records no steer), answered together with it. Still queued: owed.
  const at = view.messageOf(row)?.sequence ?? 0
  const queued = submission?.handoverRecorded === true && submission.handedOverAt === undefined
  if (queued || !(settled && idle && at > 0 && at < lastEnded)) {
    return null
  }
  return (submission?.submittedAt ?? 0) < startedAt
    ? { outcome: 'interrupted', failure: UNCONFIRMED }
    : { outcome: 'unattributed' }
}
