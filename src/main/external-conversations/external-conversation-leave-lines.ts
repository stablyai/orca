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

// Retries of a line that couldn't post, then it waits for the next watch or restart.
const RETRY_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000]

export type LeaveLinesCloud = {
  /** Null while no client runs. */
  reply: (body: ConnectorReplyBody) => Promise<{ ok: boolean }> | null
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

/** One post per turn, however often it is retried or resumed. */
export function leaveLineReplyId(sessionId: string, turnId: number): string {
  return `leave-${createHash('sha256').update(`${sessionId}:${turnId}`).digest('base64url')}`
}

export function leaveLines(deps: LeaveLinesDeps): LeaveLines {
  const timer =
    deps.setTimer ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms).unref?.()
    })
  const posting = new Set<string>()
  const owed: LeaveLines['owed'] = (link, turnId) => {
    const thread = readThreadMute(deps.store, link)
    return (
      typeof thread === 'object' && thread !== null && thread.muted && thread.leaveLine === turnId
    )
  }
  const settle = (
    link: Pick<ExternalConversationLink, 'source' | 'externalId'>,
    turnId: number
  ) => {
    if (owed(link, turnId)) {
      writeLinkFact(deps.store, link, { leaveLine: undefined })
    }
  }
  const post: LeaveLines['post'] = (link, turnId) => {
    const id = JSON.stringify([link.source, link.externalId, turnId])
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
          replyId: leaveLineReplyId(link.sessionId, turnId),
          conversation,
          turnId,
          text: THREAD_LEFT_LINE,
          // Orca's own line, on no one's behalf: no bot hears it as a person's request.
          turnFor: 'none'
        }) ?? null
      ).catch(() => null)
      if (sent?.ok) {
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
      timer(() => void attempt(retry + 1), wait)
    }
    void attempt(0)
  }
  return {
    owed,
    carried: settle,
    post,
    resume: (running) => {
      for (const { link } of allLinks(deps.store)) {
        if (link.muted && link.leaveLine !== undefined && running(link) !== link.leaveLine) {
          post(link, link.leaveLine)
        }
      }
    }
  }
}
