// How a thread's status fact changes: armed by a turn end, moved by the lines the thread sees, and
// disarmed with its numbering kept, so a later arming never reuses a reply id.
import { createHash } from 'node:crypto'
import type {
  ExternalConversationLink,
  ThreadStatusFact
} from '../../../shared/connectors/external-conversation-link'
import { allLinks, type ExternalConversationLinkStore } from '../external-conversation-links'
import { linesToday, utcDay } from './thread-status-decide'
import { THREAD_STATUS_REPLY_PREFIX } from './thread-status-lines'

type Thread = Pick<ExternalConversationLink, 'source' | 'externalId'>
type Armed = NonNullable<ThreadStatusFact['armed']>

/** A new run of lines, from a turn end now. */
export function armedFact(prior: ThreadStatusFact | undefined, now: number): ThreadStatusFact {
  return {
    seq: prior?.seq ?? 0,
    day: prior?.day ?? utcDay(now),
    dayCount: prior?.dayCount ?? 0,
    armed: { at: now, turnEndAt: now, lastLineAt: now, lastBotAt: 0, dueStep: 0 }
  }
}

export function withArmed(
  fact: ThreadStatusFact,
  armed: Armed,
  extra: Partial<ThreadStatusFact> = {}
) {
  return { ...withoutPending(fact), ...extra, armed }
}

/** A bot line: the backoff starts over. */
export function withBotLine(fact: ThreadStatusFact & { armed: Armed }, at: number) {
  return { ...fact, armed: { ...fact.armed, lastLineAt: at, lastBotAt: at, dueStep: 0 as const } }
}

/** Orca's pending line posted: counted for the day, and the next one waits longer. */
export function withHostLine(fact: ThreadStatusFact & { armed: Armed }, at: number) {
  const counted = { ...fact, day: utcDay(at), dayCount: linesToday(fact, at) + 1 }
  const dueStep = Math.min(fact.armed.dueStep + 1, 2) as Armed['dueStep']
  return withArmed(counted, { ...fact.armed, lastLineAt: at, dueStep })
}

export function withoutPending(fact: ThreadStatusFact): ThreadStatusFact {
  const { seq, day, dayCount, armed } = fact
  return { seq, day, dayCount, ...(armed ? { armed } : {}) }
}

export function disarmedFact({ seq, day, dayCount }: ThreadStatusFact): ThreadStatusFact {
  return { seq, day, dayCount }
}

/** One post per thread and line number, however often it is retried or resumed. */
export function statusReplyId(link: Thread, seq: number): string {
  const id = `${link.source}:${link.externalId}:${seq}`
  return `${THREAD_STATUS_REPLY_PREFIX}${createHash('sha256').update(id).digest('base64url')}`
}

export function armedLinks(store: ExternalConversationLinkStore) {
  return [...allLinks(store)].filter(({ link }) => link.threadStatus?.armed !== undefined)
}
