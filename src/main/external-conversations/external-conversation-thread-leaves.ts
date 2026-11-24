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

/** How a turn's end confirms a leave made in it: the line rides on a successful turn's outbox
 *  answer, and `settle` posts it on its own otherwise (a failed turn, a long answer, an end that
 *  reaches its thread another way), kept owed until it posts. */
export type TurnLeave = {
  /** The outbox prose, as the fill is about to write it, with the line after it while still owed. */
  prose: (prose: string | undefined) => string | undefined
  /** The fill wrote the turn's prose, and so the line, into an answer. */
  filled: (answered: boolean) => void
  /** The end is over: a line no answer took posts on its own, kept owed until it does. */
  settle: () => void
}

type Lines = Pick<LeaveLines, 'owed' | 'carried' | 'post' | 'ending'>

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
  // Whether the outbox prose was given the line; only then can its answer carry it.
  const appended = { prose: false }
  let rode = false
  const said = (words: string | undefined, part: keyof typeof appended) => {
    const spoken = words && !isQuietBotResult(words) ? words : undefined
    if (spoken && Buffer.byteLength(spoken) > RIDE_MAX_BYTES) {
      return words
    }
    appended[part] = true
    return withThreadLeftLine(spoken)
  }
  // Added as each goes out, never earlier: an @mention since then means it is no longer left.
  const still = () => left !== null && outcome === 'success' && left.lines.owed(link, left.turnId)
  return {
    prose: (prose) => (still() ? said(prose, 'prose') : prose),
    // The outbox has the line now: it owes nothing more.
    filled: (answered) => {
      rode ||= answered && appended.prose
      if (rode && left) {
        left.lines.carried(link, left.turnId)
      }
    },
    settle: () => {
      // An answer the fill wrote already took it over.
      if (!left || rode || !live()) {
        return
      }
      left.lines.post(link, left.turnId)
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
