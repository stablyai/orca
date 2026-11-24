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
  /** The turn as read, its outbox prose with the line after it. */
  turn: <T extends { turnProse?: string }>(turn: T) => T
  /** The end's final message, as it goes out, with the line after it while still owed. */
  words: (words: string | null | undefined) => string | undefined
  /** Before the outbox fill: an answer about to carry the line takes it over, saved first, so a
   *  quit after the fill never posts it again. */
  handOff: () => Promise<void>
  /** The fill wrote the turn's prose, and so the line, into an answer (or didn't: owed again). */
  filled: (answered: boolean) => void
  /** `carried`: the end went out with the turn's words. */
  settle: (carried?: boolean) => void
}

type Lines = Pick<LeaveLines, 'owed' | 'carried' | 'post' | 'ending' | 'handOff' | 'restore'>

// The line rides only on an answer every cloud keeps whole (the smallest takes 8 KB).
const RIDE_MAX_BYTES = 7 * 1024

export function turnLeave(
  link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'sessionId'>,
  turnId: number | null,
  outcome: string,
  given: Lines | undefined,
  live: () => boolean
): TurnLeave {
  const lines = given ?? installedLeaveLines()
  const left = lines && turnId !== null && lines.owed(link, turnId) ? { lines, turnId } : null
  if (left && live()) {
    // Held from a watch's resume while this end decides, so the line never posts twice.
    left.lines.ending(link, left.turnId)
  }
  // Which of the turn's words were given the line (its outbox prose, its final message); only
  // those can carry it.
  const appended = { prose: false, message: false }
  let handedOff = false
  let rode = false
  const said = (words: string | undefined, part: keyof typeof appended) => {
    const spoken = words && !isQuietBotResult(words) ? words : undefined
    if (spoken && Buffer.byteLength(spoken) > RIDE_MAX_BYTES) {
      return words
    }
    appended[part] = true
    return withThreadLeftLine(spoken)
  }
  return {
    // Read once the turn is: an @mention since its end began means it is no longer left.
    turn: (turn) =>
      left && outcome === 'success' && left.lines.owed(link, left.turnId)
        ? { ...turn, turnProse: said(turn.turnProse, 'prose') }
        : turn,
    words: (words) =>
      left && outcome === 'success' && left.lines.owed(link, left.turnId)
        ? said(words ?? undefined, 'message')
        : (words ?? undefined),
    handOff: async () => {
      if (left && appended.prose && live()) {
        handedOff = true
        await left.lines.handOff(link, left.turnId)
      }
    },
    filled: (answered) => {
      rode ||= answered && appended.prose
      if (handedOff && !rode && left) {
        left.lines.restore(link, left.turnId)
      }
    },
    settle: (carried) => {
      if (!left || !live()) {
        return
      }
      if (rode || (carried && appended.message)) {
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
