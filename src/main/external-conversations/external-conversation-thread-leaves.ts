// A bot that left its Slack thread during a turn: Orca's own confirmation, posted once that turn
// ends, right after its answer, and only while the thread is still left.
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import {
  installedLeaveLines,
  THREAD_LEFT_LINE,
  type LeaveLines
} from './external-conversation-leave-lines'

/** The turn's answer with the confirmation after it, or the line alone when it said nothing. */
export function withThreadLeftLine(words: string | undefined): string {
  const said = words?.trim()
  return said ? `${said}\n\n${THREAD_LEFT_LINE}` : THREAD_LEFT_LINE
}

/** How a turn's end confirms a leave made in it: the line rides on a successful turn's words, and
 *  `settle` posts it alone when they didn't carry it (a failed turn, or one whose end said nothing
 *  there). Owed only while the thread is still left: an @mention since drops it. */
export type TurnLeave = {
  /** The turn as read, its answer (prose and final message) with the line after it. */
  turn: <T extends { turnProse?: string; lastAssistantMessage?: string }>(turn: T) => T
  /** An outbox fill wrote the turn's prose, and so the line, into an answer. */
  answered: () => void
  /** `carried`: the end went out with the turn's words. */
  settle: (carried?: boolean) => void
}

type Lines = Pick<LeaveLines, 'owed' | 'carried' | 'post'>

export function turnLeave(
  link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'sessionId'>,
  turnId: number | null,
  outcome: string,
  given: Lines | undefined,
  live: () => boolean
): TurnLeave {
  const lines = given ?? installedLeaveLines()
  const left = lines && turnId !== null && lines.owed(link, turnId) ? { lines, turnId } : null
  const rides = left !== null && outcome === 'success'
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
      if (!left || !live()) {
        return
      }
      if (rode || (carried && rides)) {
        left.lines.carried(link, left.turnId)
      } else {
        left.lines.post(link, left.turnId)
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
