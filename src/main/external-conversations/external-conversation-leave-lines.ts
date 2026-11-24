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

// Waits between tries of a line that couldn't post; the last repeats while it is owed.
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
  const posting = new Set<string>()
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
    if (!conversation || posting.has(id)) {
      return
    }
    posting.add(id)
    const attempt = async (retry: number): Promise<void> => {
      if (!owed(link, turnId)) {
        posting.delete(id)
        return
      }
      const sent = await Promise.resolve(
        deps.cloud()?.reply({
          replyId: leaveLineReplyId(link, turnId),
          conversation,
          turnId,
          text: THREAD_LEFT_LINE,
          // Orca's own line, on no one's behalf: no bot hears it as a person's request.
          turnFor: 'none'
        }) ?? null
      ).catch(() => null)
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
      // While owed it keeps trying, at the longest wait once the shorter ones are spent.
      timer(() => void attempt(retry + 1), RETRY_MS[Math.min(retry, RETRY_MS.length - 1)]!)
    }
    void attempt(0)
  }
  return {
    owed,
    carried: settle,
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
        if (
          link.muted &&
          turnId !== undefined &&
          running(link) !== turnId &&
          !ending.has(idOf(link, turnId))
        ) {
          post(link, turnId)
        }
      }
    }
  }
}
