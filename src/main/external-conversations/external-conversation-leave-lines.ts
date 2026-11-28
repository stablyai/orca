// The "I've left this thread" line a bot's thread is owed once the bot left it in a turn: kept on
// the thread's link with its mute, so it posts once however the turn ends, after a restart too,
// and is dropped once an @mention brings the bot back.
import { createHash } from 'node:crypto'
import { CONNECTOR_CLOUD_MENTIONED_FEATURE } from '../../shared/connector-cloud-features'
import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorReplyBody } from '../connector-cloud/connector-replies'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { readThreadMute, writeLinkFact } from './external-conversation-link-writes'
import { threadMuteSaving } from '../connector-cloud/connector-thread-mute-saves'
import {
  allLinks,
  findLink,
  type ExternalConversationLinkStore
} from './external-conversation-links'

/** The line Orca posts as the bot once it has left; never the agent's words. */
export const THREAD_LEFT_LINE =
  "I've left this thread. New replies here won't reach me unless someone @mentions me."

// Waits between tries of a line the cloud didn't take; then the next watch or restart tries again.
const RETRY_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000]
// A turn end still deciding its line holds it from a watch's resume this long at most.
const ENDING_MS = 10 * 60_000
// Refusals no retry lifts: the line is dropped, never owed again.
const NEVER_STATUS = new Set([400, 403, 404, 413, 422])
const NEVER_ERRORS = new Set(['reply_not_accepted', 'not_this_hosts_thread'])

type Thread = Pick<ExternalConversationLink, 'source' | 'externalId'>
// An event the cloud took or dropped: a turn end or a reply names its thread and turn.
type TakenEvent = { kind: string; conversation?: Thread; turnId?: number | null }

export type LeaveLinesCloud = {
  /** What the cloud takes; null until its hello was answered. */
  cloudFeatures: () => ReadonlySet<string> | null
  /** Whether `turnId`'s end in the thread still waits for the cloud to take it. */
  turnEndPending?: (conversation: Thread, turnId: number) => boolean
  /** Null while no client runs. `proceed`: asked before each of the client's own retries. */
  reply: (
    body: ConnectorReplyBody,
    proceed?: () => boolean
  ) => Promise<{ ok: true } | { ok: false; status: number | null; error: string | null }> | null
}

type LeaveLinesDeps = {
  store: ExternalConversationLinkStore
  /** Null while no client runs: the line waits. */
  cloud: () => LeaveLinesCloud | null
  setTimer?: (run: () => void, ms: number) => void
  /** Saves pending store writes to disk. */
  flush?: () => Promise<void>
  /** Whether the reply outbox still holds `turnId`'s answer in the thread, not yet taken by the
   *  cloud: the line waits for it, after a restart too. Rejects when it can't tell. */
  answerPending?: (
    link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'sessionId'>,
    turnId: number
  ) => Promise<boolean>
}

export type LeaveLines = {
  /** Whether the link still owes `turnId`'s line: still left, and no @mention since. */
  owed: (link: Pick<ExternalConversationLink, 'source' | 'externalId'>, turnId: number) => boolean
  /** Posts the line on its own, retrying until it posts or is no longer owed. */
  post: (
    link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'sessionId'>,
    turnId: number
  ) => void
  /** A turn end is deciding `turnId`'s line (on its answer or alone): a resume leaves it alone. */
  ending: (link: Thread, turnId: number) => void
  /** Posts the line once the cloud took `turnId`'s end, so it lands after the answer. `fallback`:
   *  tries again later for an end the cloud dropped; else the next watch does. */
  afterTurnEnd: (
    link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'sessionId'>,
    turnId: number,
    fallback: boolean
  ) => void
  /** The cloud took these events: lines waiting on a turn end or answer among them post now. */
  turnEndsTaken: (events: readonly TakenEvent[]) => void
  /** Posts every line still owed for a turn that isn't running (cut short by a quit or a reset). */
  resume: (running: (link: ExternalConversationLink) => number | null) => void
}

let installed: LeaveLines | null = null

/** The process's lines, set as its conversations are installed; a turn's end posts through them. */
export function installLeaveLines<T extends LeaveLines | null>(lines: T): T {
  installed = lines
  return lines
}

export function installedLeaveLines(): LeaveLines | null {
  return installed
}

/** One post per thread and turn, however often it is retried or resumed, whichever chat it is in. */
export function leaveLineReplyId(link: Thread, turnId: number): string {
  const id = `${link.source}:${link.externalId}:${turnId}`
  return `leave-${createHash('sha256').update(id).digest('base64url')}`
}

// A mirrored turn's end the owner's failed post still holds, kept on the link across a restart.
function heldByMirror(store: ExternalConversationLinkStore, link: Thread, turnId: number): boolean {
  return (findLink(store, link)?.link.mirrorHeld ?? []).some(
    ({ event }) =>
      typeof event === 'object' && event !== null && 'turnId' in event && event.turnId === turnId
  )
}

export function leaveLines(deps: LeaveLinesDeps): LeaveLines {
  const timer =
    deps.setTimer ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms).unref?.()
    })
  // Lines posting now, each with what wakes its waiting retry at once.
  const posting = new Map<string, () => void>()
  // Turn ends deciding their line, by when they began; a watch's resume leaves these alone.
  const ending = new Map<string, number>()
  const idOf = (link: Thread, turnId: number) =>
    JSON.stringify([link.source, link.externalId, turnId])
  const owed: LeaveLines['owed'] = (link, turnId) => {
    const thread = readThreadMute(deps.store, link)
    return (
      typeof thread === 'object' && thread !== null && thread.muted && thread.leaveLine === turnId
    )
  }
  const settle = (link: Thread, turnId: number) => {
    ending.delete(idOf(link, turnId))
    if (owed(link, turnId)) {
      writeLinkFact(deps.store, link, { leaveLine: undefined })
      // Saved now, so a quit can't post it again.
      void deps.flush?.().catch(() => undefined)
    }
  }
  const post: LeaveLines['post'] = (link, turnId) => {
    const id = idOf(link, turnId)
    ending.delete(id)
    const conversation = cloudConversation(link)
    if (!conversation) {
      return
    }
    // Already posting: a reconnect tries it now rather than after its wait.
    const waiting = posting.get(id)
    if (waiting) {
      waiting()
      return
    }
    let tries = 0
    posting.set(id, () => {})
    const attempt = async (retry: number): Promise<void> => {
      // Tried again after the next wait, or by the next watch once the waits run out.
      const later = () => {
        const wait = RETRY_MS[retry]
        if (wait === undefined) {
          console.warn(
            '[connectors] could not post that a bot left its thread; it posts on reconnect'
          )
          posting.delete(id)
          return
        }
        const mine = ++tries
        const next = () => {
          // A wake and its timer both fire: only the first tries.
          if (mine === tries) {
            tries += 1
            void attempt(retry + 1)
          }
        }
        posting.set(id, next)
        timer(next, wait)
      }
      // The leave's save is on disk first: one that fails puts the thread back, owing nothing, and
      // one whose outcome was unknown is written again before the line says so.
      await threadMuteSaving(link)?.catch(() => undefined)
      if (owed(link, turnId) && deps.flush) {
        try {
          await deps.flush()
        } catch {
          later()
          return
        }
      }
      // Its answer goes first: the reply that carries it (looked up first, and a lookup that fails
      // is tried again), then the end that carries it or the end an owner's failed post holds, read
      // after that lookup so one that arrived meanwhile counts. Its acceptance wakes this; the waits
      // cover a route that doesn't (Orca's /replies).
      const answering =
        owed(link, turnId) &&
        (await Promise.resolve(deps.answerPending?.(link, turnId)).then(
          (unsent) => unsent === true,
          () => true
        ))
      const cloud = deps.cloud()
      const pending =
        answering ||
        cloud?.turnEndPending?.(link, turnId) === true ||
        heldByMirror(deps.store, link, turnId)
      // Read after any wait: an @mention meanwhile means it is no longer left.
      if (!owed(link, turnId)) {
        posting.delete(id)
        return
      }
      if (pending) {
        later()
        return
      }
      // No client runs (signed out, quitting): the next watch starts the line again.
      if (!cloud) {
        posting.delete(id)
        return
      }
      // A cloud that may let every reply wake the bot would make the line false: one known to lack
      // mentions keeps it owed for one that has them; one not yet answered is tried again.
      const features = cloud.cloudFeatures()
      if (features && !features.has(CONNECTOR_CLOUD_MENTIONED_FEATURE)) {
        posting.delete(id)
        return
      }
      if (!features) {
        later()
        return
      }
      const replying = cloud.reply(
        {
          replyId: leaveLineReplyId(link, turnId),
          conversation,
          turnId,
          text: THREAD_LEFT_LINE,
          // Orca's own line, on no one's behalf: no bot hears it as a person's request.
          turnFor: 'none'
        },
        // An @mention during a retry's wait means it is no longer left.
        () => owed(link, turnId)
      )
      if (!replying) {
        posting.delete(id)
        return
      }
      const sent = await replying.catch(() => null)
      // Posted, or refused for good (another account's thread, a body the cloud won't take).
      const never =
        sent !== null &&
        !sent.ok &&
        ((sent.status !== null && NEVER_STATUS.has(sent.status)) ||
          (sent.error !== null && NEVER_ERRORS.has(sent.error)))
      if (sent?.ok || never) {
        if (never) {
          console.warn('[connectors] dropped a "left this thread" line the cloud refused')
        }
        posting.delete(id)
        settle(link, turnId)
        return
      }
      later()
    }
    void attempt(0)
  }
  return {
    owed,
    post,
    ending: (link, turnId) => {
      ending.set(idOf(link, turnId), Date.now())
    },
    afterTurnEnd: (link, turnId, fallback) => {
      ending.set(idOf(link, turnId), Date.now())
      if (fallback) {
        // Still waiting then means the end is still queued; this only catches one the cloud dropped.
        timer(() => post(link, turnId), ENDING_MS)
      }
    },
    turnEndsTaken: (events) => {
      for (const event of events) {
        if (event.kind !== 'turn-ended' && event.kind !== 'reply') {
          continue
        }
        const { conversation, turnId } = event
        const link = conversation && findLink(deps.store, conversation)?.link
        if (link && typeof turnId === 'number' && owed(link, turnId)) {
          post(link, turnId)
        }
      }
    },
    resume: (running) => {
      const now = Date.now()
      for (const [id, at] of ending) {
        if (now - at > ENDING_MS) {
          ending.delete(id)
        }
      }
      for (const { link } of allLinks(deps.store)) {
        const turnId = link.leaveLine
        if (!link.muted || turnId === undefined || running(link) === turnId) {
          continue
        }
        const began = ending.get(idOf(link, turnId))
        if (began === undefined) {
          post(link, turnId)
        } else {
          // Its turn end is deciding it; one that never finishes (a reset meanwhile) lets go here.
          timer(() => post(link, turnId), began + ENDING_MS - now)
        }
      }
    }
  }
}
