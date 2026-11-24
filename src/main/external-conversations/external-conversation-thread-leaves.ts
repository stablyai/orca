// A bot that left its Slack thread during a turn: Orca's own confirmation, posted once that turn
// ends, right after its answer, and only while the thread is still left.
import { isQuietBotResult } from '../../shared/bot-quiet-result'

/** The line Orca posts as the bot once it has left; never the agent's words. */
export const THREAD_LEFT_LINE =
  "I've left this thread. New replies here won't reach me unless someone @mentions me."

export type ThreadLeft = {
  /** The turn it left in, as the thread's conversation numbers it. */
  turnId: number
  /** Whether the thread is still left: an @mention since then drops the confirmation. */
  stillLeft: () => boolean
  /** Posts the line on its own, once however often it is retried. */
  post: () => Promise<void>
}

const left = new Map<string, ThreadLeft>()

/** Records a leave in this turn; false when one is already recorded for it. */
export function noteThreadLeft(sessionId: string, leave: ThreadLeft): boolean {
  if (left.get(sessionId)?.turnId === leave.turnId) {
    return false
  }
  left.set(sessionId, leave)
  return true
}

export function leftInTurn(sessionId: string, turnId: number | null): boolean {
  return turnId !== null && left.get(sessionId)?.turnId === turnId
}

/** The leave of the turn now ending, taken so it confirms once; null for any other turn. */
export function takeThreadLeft(sessionId: string, turnId: number | null): ThreadLeft | null {
  const leave = left.get(sessionId)
  if (!leave || turnId === null || leave.turnId > turnId) {
    return null
  }
  // A later turn's end: the leave's own end went unseen, so its line is dropped, never misplaced.
  if (leave.turnId < turnId) {
    left.delete(sessionId)
    return null
  }
  left.delete(sessionId)
  return leave.stillLeft() ? leave : null
}

/** The turn's answer with the confirmation after it, or the line alone when it said nothing. */
export function withThreadLeftLine(words: string | undefined): string {
  const said = words?.trim()
  return said ? `${said}\n\n${THREAD_LEFT_LINE}` : THREAD_LEFT_LINE
}

/** How a turn's end confirms a leave made in it: the line rides on a successful turn's words, and
 *  `settle` posts it alone when they didn't carry it (a failed turn, or one whose end said nothing
 *  there). */
export type TurnLeave = {
  /** The turn as read, its answer (prose and final message) with the line after it. */
  turn: <T extends { turnProse?: string; lastAssistantMessage?: string }>(turn: T) => T
  /** An outbox fill wrote the turn's prose, and so the line, into an answer. */
  answered: () => void
  /** `carried`: the end went out with the turn's words. */
  settle: (carried?: boolean) => void
}

export function turnLeave(
  news: { sessionId: string; outcome: string },
  turnId: number | null,
  live: () => boolean
): TurnLeave {
  const leave = takeThreadLeft(news.sessionId, turnId)
  const rides = leave !== null && news.outcome === 'success'
  let rode = false
  const said = (words: string | undefined) =>
    withThreadLeftLine(words && !isQuietBotResult(words) ? words : undefined)
  return {
    turn: (turn) =>
      rides
        ? {
            ...turn,
            turnProse: said(turn.turnProse),
            lastAssistantMessage: said(turn.lastAssistantMessage)
          }
        : turn,
    answered: () => {
      rode ||= rides
    },
    settle: (carried) => {
      if (leave && !(rode || (carried && rides)) && live()) {
        void leave.post()
      }
    }
  }
}

/** The Slack thread a message ref (`slack:T:C:thread:ts`) is in, as its conversation id starts
 *  (`T:C:thread`); null for any other ref. */
export function slackThreadOfRef(messageRef: string | undefined): string | null {
  const [scheme, team, channel, thread] = (messageRef ?? '').split(':').map(decodeURIComponent)
  return scheme === 'slack' && team && channel && thread ? `${team}:${channel}:${thread}` : null
}

type Asker = Parameters<typeof askedInThread>[0]

/** Whether a person who can ask the bot wrote it, in the Slack thread `externalId` (`T:C:thread:UBOT`)
 *  names: never another app, nor an Orca bot writing for someone. */
export function askedInThread(
  asker: {
    role: string
    app?: true
    via?: unknown
    messageRef?: string
  },
  externalId: string
): boolean {
  const [team, channel, thread] = externalId.split(':')
  return (
    (asker.role === 'owner' || asker.role === 'member') &&
    !asker.app &&
    !asker.via &&
    slackThreadOfRef(asker.messageRef) === `${team}:${channel}:${thread}`
  )
}

/** A delivery's mark that its turn may leave the bot's Slack thread: only when a person who can ask
 *  the bot there wrote every message of its batch, as Orca found when it delivered it. */
export function leaveEligibleBatch(
  link: { bot?: unknown; source: string; externalId: string },
  head: Asker | undefined,
  later: readonly { asker?: Asker }[] = []
): { leaveEligible?: true } {
  const askers = [head, ...later.map((each) => each.asker)]
  return link.bot &&
    link.source === 'slack' &&
    askers.every((asker) => asker !== undefined && askedInThread(asker, link.externalId))
    ? { leaveEligible: true }
    : {}
}
