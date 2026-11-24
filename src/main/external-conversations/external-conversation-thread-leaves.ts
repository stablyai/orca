// A bot that left its Slack thread during a turn: Orca's own confirmation, posted once that turn
// ends, right after its answer, and only while the thread is still left.
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { installedLeaveLines, type LeaveLines } from './external-conversation-leave-lines'

/** How a turn's end confirms a leave made in it: the line posts on its own once the turn's answer
 *  is in (design: right after the turn's final message), kept owed until it posts. */
export type TurnLeave = {
  /** The end is over. `after`: once the cloud took the end just emitted ('end'), or one an owner's
   *  failed post holds ('held'); without it, at once (an end that reaches the thread another way). */
  settle: (after?: 'end' | 'held') => void
}

type Lines = Pick<LeaveLines, 'owed' | 'post' | 'ending' | 'afterTurnEnd'>

export function turnLeave(
  link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'sessionId'>,
  turnId: number | null,
  given: Lines | undefined,
  live: () => boolean
): TurnLeave {
  const lines = given ?? installedLeaveLines()
  const left = lines && turnId !== null && lines.owed(link, turnId) ? { lines, turnId } : null
  if (left && live()) {
    // Held from a watch's resume while this end decides, so the line never posts twice.
    left.lines.ending(link, left.turnId)
  }
  return {
    settle: (after) => {
      if (!left || !live()) {
        return
      }
      if (after) {
        left.lines.afterTurnEnd(link, left.turnId, after === 'end')
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
