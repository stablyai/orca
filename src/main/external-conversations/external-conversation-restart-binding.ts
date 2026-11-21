import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalConnectorDelivery,
  AgentJournalRestartOf
} from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { AgentSessionResumeWork } from '../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { connectorReplyTurnStamps } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  agentTurnVerdict,
  type AgentTurnOutcome
} from '../../shared/agent-status/lifecycle/agent-turn-outcome'

// A restart continuation answers the requests of the work it resumes (design: slack-reply-lost-
// restart, D2 §2). Everything here reads one journal window of one session and epoch, and fails
// closed: anything it can't prove binds nothing.

type Window = Pick<AgentJournalSnapshot, 'items' | 'submissions'>

/** A turn row's settled verdict, interruption derived from its lifecycle; null while unresolved
 *  (running, or an end no evidence proves). */
export function settledTurnVerdict(
  item: AgentJournalRenderItem
): Exclude<AgentTurnOutcome, 'unconfirmed'> | null {
  const turn = readAgentJournalTurn(item.body)
  if (!turn) {
    return null
  }
  const verdict = agentTurnVerdict({
    state: turn.state,
    outcome: readAgentJournalTurnOutcome(turn)
  })
  return verdict === 'unconfirmed' ? null : verdict
}

/** When a turn row's end is on record, else when it was first seen (earlier, so never fresher). */
export function turnEndedAt(item: AgentJournalRenderItem): number {
  return readAgentJournalTurn(item.body)?.completedAt ?? item.observedAt
}

const rootTurns = (window: Window) =>
  window.items.filter((item) => isRootAgentJournalItem(item) && readAgentJournalTurn(item.body))

/** The interrupted work a continuation resumed, and the requests it inherits from it. */
export type RestartBinding = {
  /** The resumed turn row, or the resumed send's message when it never became a turn. */
  resumed: AgentJournalRenderItem
  stamps: AgentJournalConnectorDelivery[]
}

export type RestartBindingReads = {
  /** A turn row's opener; undefined when its aliases can't be read. */
  openerOf: (turnItemId: string) => Promise<AgentJournalRenderItem | null | undefined>
  chainMax: number
}

const restartOfItem = (item: AgentJournalRenderItem | null | undefined) =>
  item?.body.kind === 'message' ? item.body.restartOf : undefined

/**
 * What a continuation message resumes, verified: exactly one match before it in this window, a turn
 * that ended interrupted (or a send whose dispatch is in doubt), and no other root turn between the
 * two. A chained continuation (the resumed turn's own opener resumed something) adds that work's
 * requests, at most `chainMax` hops. Null binds nothing.
 */
export async function restartBinding(
  window: Window,
  continuation: AgentJournalRenderItem,
  reads: RestartBindingReads,
  hop = 1
): Promise<RestartBinding | null> {
  const restartOf = restartOfItem(continuation)
  if (!restartOf || hop > reads.chainMax) {
    return null
  }
  const sent = window.submissions.find(
    (submission) => agentJournalSubmissionKey(submission.clientMessageId) === continuation.itemId
  )
  // Only Orca writes it; a client's send can't carry it (SendBody is strict), and this says so too.
  if (sent?.origin === 'client') {
    return null
  }
  const roots = rootTurns(window).filter((turn) => turn.sequence < continuation.sequence)
  const between = (from: AgentJournalRenderItem) =>
    roots.some((turn) => turn.sequence > from.sequence && turn.itemId !== from.itemId)
  const resumed = await resumedWork(window, roots, restartOf, continuation, reads)
  if (!resumed || between(resumed.item)) {
    return null
  }
  if (resumed.kind === 'send') {
    const stamp =
      resumed.item.body.kind === 'message' ? resumed.item.body.connectorDelivery : undefined
    return { resumed: resumed.item, stamps: stamp ? [stamp] : [] }
  }
  if (settledTurnVerdict(resumed.item) !== 'interruption') {
    return null
  }
  const opener = await reads.openerOf(resumed.item.itemId)
  if (opener === undefined) {
    return null
  }
  const stamps = connectorReplyTurnStamps(window, opener, resumed.item.itemId)
  const chained =
    opener && restartOfItem(opener) ? await restartBinding(window, opener, reads, hop + 1) : null
  return { resumed: resumed.item, stamps: [...stamps, ...(chained?.stamps ?? [])] }
}

async function resumedWork(
  window: Window,
  roots: readonly AgentJournalRenderItem[],
  restartOf: AgentJournalRestartOf,
  continuation: AgentJournalRenderItem,
  reads: RestartBindingReads
): Promise<{ kind: 'turn' | 'send'; item: AgentJournalRenderItem } | null> {
  const one = (matches: readonly AgentJournalRenderItem[]) =>
    matches.length === 1 && matches[0] ? { kind: 'turn' as const, item: matches[0] } : null
  switch (restartOf.kind) {
    case 'turn':
      return one(roots.filter((turn) => readAgentJournalTurn(turn.body)?.turnId === restartOf.id))
    case 'turn-item':
      return one(roots.filter((turn) => turn.itemId === restartOf.id))
    case 'submission': {
      const key = agentJournalSubmissionKey(restartOf.id)
      const message = window.items.find(
        (item) => item.itemId === key && item.sequence < continuation.sequence
      )
      if (!message) {
        return null
      }
      // A send that became a turn is resumed as that turn.
      const openers = await Promise.all(roots.map((turn) => reads.openerOf(turn.itemId)))
      if (openers.some((opener) => opener === undefined)) {
        return null
      }
      const became = roots.filter((_, index) => openers[index]?.itemId === key)
      if (became.length > 0) {
        return one(became)
      }
      const submission = window.submissions.find(
        (candidate) => agentJournalSubmissionKey(candidate.clientMessageId) === key
      )
      // A send not yet a turn is resumed only while its dispatch is in doubt.
      return submission?.dispatchState === 'unknown' && !submission.answeredInTurn
        ? { kind: 'send', item: message }
        : null
    }
  }
}

/** Whether a restart offer still standing names this work: a turn by its lifecycle id, a send by
 *  its client message id. */
export function offerNames(
  offers: readonly AgentSessionResumeWork[],
  work: { turnId?: string; clientMessageId?: string }
): boolean {
  return offers.some(
    (offer) =>
      (offer.kind === 'turn' && offer.id === work.turnId) ||
      (offer.kind === 'submission' && offer.id === work.clientMessageId)
  )
}

/** Messages a person typed into the chat from the continuation on, before the turn after its own
 *  turn opened: what a Slack mirror would have posted, and so released that turn's answer itself. */
export function personMessagesDuring(
  window: Window,
  continuation: AgentJournalRenderItem,
  continuationTurn: AgentJournalRenderItem
): string[] {
  const next = rootTurns(window).find((turn) => turn.sequence > continuationTurn.sequence)
  return window.items
    .filter(
      (item) =>
        item.sequence > continuation.sequence &&
        (next === undefined || item.sequence < next.sequence) &&
        item.body.kind === 'message' &&
        item.body.role === 'user' &&
        !item.body.from &&
        !item.body.origin &&
        !item.body.command &&
        !item.body.restartOf &&
        !item.body.connectorDelivery
    )
    .map((item) => item.itemId)
}
