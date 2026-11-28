// How a thread's status fact changes: armed by a turn end, moved by the lines the thread sees, and
// disarmed with its numbering kept, so a later arming never reuses a reply id.
import { createHash } from 'node:crypto'
import type {
  ExternalConversationLink,
  ThreadStatusFact
} from '../../../shared/connectors/external-conversation-link'
import { writeLinkFact } from '../external-conversation-link-writes'
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

/** A heard turn end restarts the 6 hour clock. Only a line the thread sees, its answer included,
 *  restarts the wait for the next one. */
export function withTurnEnd(fact: ThreadStatusFact & { armed: Armed }, at: number) {
  return { ...fact, armed: { ...fact.armed, turnEndAt: at } }
}

/** A bot line: the backoff starts over. */
export function withBotLine(fact: ThreadStatusFact & { armed: Armed }, at: number) {
  return { ...fact, armed: { ...fact.armed, lastLineAt: at, lastBotAt: at, dueStep: 0 as const } }
}

/** Orca's pending line posted: counted for the day, and the next one waits longer. */
export function withHostLine(fact: ThreadStatusFact & { armed: Armed }, at: number) {
  const counted = { ...fact, day: utcDay(at), dayCount: linesToday(fact, at) + 1 }
  const dueStep = nextDueStep(fact.armed.dueStep)
  const lines = (fact.armed.lines ?? 0) + 1
  return withArmed(counted, { ...fact.armed, lastLineAt: at, dueStep, lines })
}

/** The backoff step after a host line: 30 min, then 60, then 120 from there on. */
export function nextDueStep(step: Armed['dueStep']): Armed['dueStep'] {
  return step === 0 ? 1 : 2
}

/** A saved line decided too long ago, or no later than a bot line the thread saw since: never
 *  posted. Orca's own line before it was the one it followed, so only a bot's can overtake it. */
export function stalePending(fact: ThreadStatusFact, now: number, maxMs: number): boolean {
  const { pending, armed } = fact
  return !!pending && (now - pending.at > maxMs || (armed?.lastBotAt ?? 0) >= pending.at)
}

/** A saved line dropped without being told it posted. One that may have posted counts as Orca's
 *  line as of now, after any send of it could have landed, whatever bot lines came meanwhile: the
 *  next line keeps the backoff, none under a new id follows it too soon, and a stop line ends the
 *  run. */
export function withoutSavedLine(
  fact: ThreadStatusFact,
  now: number,
  mayHavePosted: boolean
): ThreadStatusFact {
  const { armed, pending } = fact
  if (!armed || !pending || !mayHavePosted) {
    return withoutPending(fact)
  }
  const posted = withHostLine({ ...fact, armed }, now)
  return pending.stop ? disarmedFact(posted) : posted
}

export function withoutPending(fact: ThreadStatusFact): ThreadStatusFact {
  const { seq, day, dayCount, armed } = fact
  return { seq, day, dayCount, ...(armed ? { armed } : {}) }
}

export function disarmedFact({ seq, day, dayCount }: ThreadStatusFact): ThreadStatusFact {
  return { seq, day, dayCount }
}

/** One post per thread, run and line number, however often it is retried or resumed; the run's
 *  start keeps ids unique when a dropped link starts the numbering over. */
export function statusReplyId(link: Thread, runAt: number, seq: number): string {
  const id = `${link.source}:${link.externalId}:${runAt}:${seq}`
  return `${THREAD_STATUS_REPLY_PREFIX}${createHash('sha256').update(id).digest('base64url')}`
}

export function armedLinks(store: ExternalConversationLinkStore) {
  return [...allLinks(store)].filter(({ link }) => link.threadStatus?.armed !== undefined)
}

/** Keeps the fact on its link; a failed write is logged, and this process still has its state. */
export function writeThreadStatus(
  store: ExternalConversationLinkStore,
  link: Thread,
  threadStatus: ThreadStatusFact
): void {
  try {
    writeLinkFact(store, link, { threadStatus })
  } catch (error) {
    console.warn('[connectors] could not keep a thread’s status lines on its link', error)
  }
}
