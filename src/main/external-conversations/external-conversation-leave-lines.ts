// The "I've left this thread" line a bot's thread is owed once the bot left it in a turn: kept on
// the thread's link with its mute, so it posts once however the turn ends, after a restart too,
// and is dropped once an @mention brings the bot back.
import { createHash } from 'node:crypto'
import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorReplyBody } from '../connector-cloud/connector-replies'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { readThreadMute, writeLinkFact } from './external-conversation-link-writes'
import { allLinks, type ExternalConversationLinkStore } from './external-conversation-links'

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

export type LeaveLinesCloud = {
  /** Null while no client runs. */
  reply: (
    body: ConnectorReplyBody
  ) => Promise<{ ok: true } | { ok: false; status: number | null; error: string | null }> | null
}

type LeaveLinesDeps = {
  store: ExternalConversationLinkStore
  /** Null while no client runs: the line waits. */
  cloud: () => LeaveLinesCloud | null
  setTimer?: (run: () => void, ms: number) => void
  /** Saves pending store writes to disk. */
  flush?: () => Promise<void>
}

export type LeaveLines = {
  /** Whether the link still owes `turnId`'s line: still left, and no @mention since. */
  owed: (link: Pick<ExternalConversationLink, 'source' | 'externalId'>, turnId: number) => boolean
  /** The line went with the turn's answer: nothing more is owed. */
  carried: (link: Pick<ExternalConversationLink, 'source' | 'externalId'>, turnId: number) => void
  /** Posts the line on its own, retrying until it posts or is no longer owed. */
  post: (
    link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'sessionId'>,
    turnId: number
  ) => void
  /** An answer is about to carry the line: owed no more, saved before the answer is. */
  handOff: (link: Thread, turnId: number) => Promise<void>
  /** The answer didn't carry it after all: owed again, while the thread is still left. */
  restore: (link: Thread, turnId: number) => void
  /** A turn end is deciding `turnId`'s line (on its answer or alone): a resume leaves it alone. */
  ending: (link: Thread, turnId: number) => void
  /** Posts every line still owed for a turn that isn't running (cut short by a quit or a reset). */
  resume: (running: (link: ExternalConversationLink) => number | null) => void
}

let installed: LeaveLines | null = null

/** The process's lines, set as its conversations are installed; a turn's end posts through them. */
export function installLeaveLines(lines: LeaveLines | null): void {
  installed = lines
}

export function installedLeaveLines(): LeaveLines | null {
  return installed
}

/** One post per thread and turn, however often it is retried or resumed, whichever chat it is in. */
export function leaveLineReplyId(link: Thread, turnId: number): string {
  const id = `${link.source}:${link.externalId}:${turnId}`
  return `leave-${createHash('sha256').update(id).digest('base64url')}`
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
      if (!owed(link, turnId)) {
        posting.delete(id)
        return
      }
      const replying = deps.cloud()?.reply({
        replyId: leaveLineReplyId(link, turnId),
        conversation,
        turnId,
        text: THREAD_LEFT_LINE,
        // Orca's own line, on no one's behalf: no bot hears it as a person's request.
        turnFor: 'none'
      })
      // No client runs (signed out, quitting): the next watch starts the line again.
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
    void attempt(0)
  }
  return {
    owed,
    carried: settle,
    handOff: async (link, turnId) => {
      if (owed(link, turnId)) {
        writeLinkFact(deps.store, link, { leaveLine: undefined })
        // A failed save leaves it to a restart, which may post it again: never a false line.
        await deps.flush?.().catch(() => undefined)
      }
    },
    restore: (link, turnId) => {
      const thread = readThreadMute(deps.store, link)
      if (
        typeof thread === 'object' &&
        thread !== null &&
        thread.muted &&
        thread.leaveLine === undefined
      ) {
        writeLinkFact(deps.store, link, { leaveLine: turnId })
      }
    },
    post,
    ending: (link, turnId) => {
      ending.set(idOf(link, turnId), Date.now())
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
