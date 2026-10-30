import { z } from 'zod'
import { buildNativeChatSubscriptionId } from '../../../src/shared/native-chat/native-chat-stream-unsubscribe'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import type { RpcClient } from '../transport/rpc-client'
import { chatTargetForPane, readWorktreeTabs, type ChatTarget, type Tab } from './chat-feed-target'
import { logSpeechEvent } from './speech-diagnostics'

// Why: `worktree.ps` only carries a turn's final message, so mid-turn ones come from each pane's
// chat feed; Claude writes each content block whole, so an appended assistant row is final.

/** A main agent pane from `worktree.ps`; `paneKey` carries the host prefix, `rawPaneKey` not. */
export type AgentPane = {
  paneKey: string
  rawPaneKey: string
  worktreeId: string
  /** Host clock (ms) when the running turn began, null while the agent is idle. */
  turnStartedAt: number | null
}

const frameSchema = z.looseObject({
  type: z.string().optional(),
  pending: z.boolean().optional(),
  error: z.string().optional(),
  messages: z
    .array(
      z.looseObject({
        id: z.string(),
        role: z.string(),
        timestamp: z.number().nullish(),
        blocks: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).catch([])
      })
    )
    .catch([])
    .optional()
})
type FrameMessage = NonNullable<z.infer<typeof frameSchema>['messages']>[number]

export function assistantText(message: FrameMessage): string | null {
  if (message.role !== 'assistant') {
    return null
  }
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
    .join('\n\n')
  const spoken = withoutNativeChatVisualDirectiveLines(text).trim()
  return spoken.length > 0 ? spoken : null
}

// Why: lets a final reply match the same message already heard from the feed.
function sameMessageKey(text: string): string {
  return withoutNativeChatVisualDirectiveLines(text).replace(/\s+/g, ' ').trim().slice(0, 200)
}

// Why: a reconnect or rewrite replays a window; read only its latest few unheard messages.
const MAX_REPLAYED = 3
const UNRESOLVED_RETRY_MS = 10_000
const RESOLVED_RECHECK_MS = 60_000
const MAX_REMEMBERED = 20
// Why: a final reply the feed has not read by then is read from `worktree.ps` instead.
const FEED_GRACE_POLLS = 2

type Feed = {
  hostId: string
  client: RpcClient
  target: ChatTarget
  resolvedAt: number
  close: () => void
  seen: Set<string>
  baselined: boolean
  pendingBase: boolean
  turnStartedAt: number | null
}

export type AwaitedReply = { id: string; paneKey: string; text: string }

export type ChatMessageFeeds = {
  sync(hostId: string, client: RpcClient, panes: readonly AgentPane[], now: number): Promise<void>
  /** Whether this pane's messages are reaching the reader through a feed. */
  covers(paneKey: string): boolean
  /** Whether this reply was already spoken from the feed. */
  heard(paneKey: string, text: string): boolean
  /** Holds a final reply that this pane's feed should read. */
  awaitReply(reply: AwaitedReply): void
  /** Held replies the feed has not read within the grace, marked heard so it never reads them. */
  overdue(feedsReading: boolean): AwaitedReply[]
  /** Closes the feeds of hosts that are no longer known. */
  keepHosts(hostIds: ReadonlySet<string>): void
  closeAll(): void
}

/** `speak` answers whether it read the message, which is what `heard` remembers. */
export function createChatMessageFeeds(
  speak: (paneKey: string, messageId: string, text: string) => boolean
): ChatMessageFeeds {
  const feeds = new Map<string, Feed>()
  const lastAttempt = new Map<string, number>()
  const spoken = new Map<string, string[]>()
  const awaited = new Map<string, AwaitedReply & { polls: number }>()

  const remember = (paneKey: string, text: string) => {
    const keys = [sameMessageKey(text), ...(spoken.get(paneKey) ?? [])]
    spoken.set(paneKey, keys.slice(0, MAX_REMEMBERED))
  }
  const heard = (paneKey: string, text: string) =>
    (spoken.get(paneKey) ?? []).includes(sameMessageKey(text))

  const announce = (paneKey: string, messages: readonly FrameMessage[]) => {
    for (const message of messages) {
      const text = assistantText(message)
      // Why: a reopened feed replays what an earlier feed or the final-reply check already read.
      if (text && !heard(paneKey, text) && speak(paneKey, message.id, text)) {
        remember(paneKey, text)
      }
    }
  }

  const drop = (paneKey: string, feed: Feed) => {
    if (feeds.get(paneKey) === feed) {
      feeds.delete(paneKey)
    }
    feed.close()
  }

  const onFrame = (paneKey: string, feed: Feed, raw: unknown) => {
    if (feeds.get(paneKey) !== feed) {
      return
    }
    const parsed = frameSchema.safeParse(raw)
    if (!parsed.success) {
      return
    }
    const frame = parsed.data
    if (frame.type === 'error' || frame.type === 'end') {
      logSpeechEvent(`chat feed ${frame.type}: ${paneKey}`)
      drop(paneKey, feed)
      return
    }
    // Why: an unreadable transcript is no baseline; the snapshot that replaces it is.
    if (frame.error) {
      return
    }
    if (frame.type === 'snapshot' && frame.pending) {
      // Why: no transcript yet, so whatever the next snapshot holds was written after this.
      feed.pendingBase = true
      return
    }
    const unseen = (frame.messages ?? []).filter((message) => !feed.seen.has(message.id))
    for (const message of unseen) {
      feed.seen.add(message.id)
    }
    if (frame.type === 'appended' && feed.baselined) {
      announce(paneKey, unseen)
      return
    }
    if (frame.type !== 'snapshot' && frame.type !== 'replacement') {
      return
    }
    if (feed.baselined) {
      announce(paneKey, unseen.filter((message) => assistantText(message)).slice(-MAX_REPLAYED))
      return
    }
    feed.baselined = true
    // Why: the first snapshot is history, but a feed opened mid-turn owes that turn's messages.
    const since = feed.pendingBase ? Number.NEGATIVE_INFINITY : feed.turnStartedAt
    if (since !== null) {
      const thisTurn = unseen.filter(
        (message) => assistantText(message) && (message.timestamp ?? 0) >= since
      )
      announce(paneKey, thisTurn.slice(-MAX_REPLAYED))
    }
  }

  const open = (
    pane: AgentPane,
    hostId: string,
    client: RpcClient,
    target: ChatTarget,
    now: number
  ) => {
    const feed: Feed = {
      hostId,
      client,
      target,
      resolvedAt: now,
      close: () => undefined,
      seen: new Set(),
      baselined: false,
      pendingBase: false,
      turnStartedAt: pane.turnStartedAt
    }
    feeds.set(pane.paneKey, feed)
    feed.close = client.subscribe(
      'nativeChat.subscribe',
      {
        agent: target.agent,
        sessionId: target.sessionId,
        limit: 20,
        // Why: a token of its own, so the chat screen's feed on the same session is not evicted.
        subscriptionId: buildNativeChatSubscriptionId(
          target.agent,
          target.sessionId,
          randomV4Uuid()
        ),
        capabilities: { transcriptPending: 1 },
        ...(target.transcriptPath ? { transcriptPath: target.transcriptPath } : {})
      },
      (raw) => onFrame(pane.paneKey, feed, raw)
    )
  }

  return {
    async sync(hostId, client, panes, now) {
      const present = new Set(panes.map((pane) => pane.paneKey))
      for (const [paneKey, feed] of feeds) {
        if (feed.hostId !== hostId) {
          continue
        }
        // Why: a replaced host client ended this feed's subscription, so it reopens on the new one.
        if (feed.client !== client) {
          lastAttempt.delete(paneKey)
        }
        if (!present.has(paneKey) || feed.client !== client) {
          drop(paneKey, feed)
        }
      }
      const due = panes.filter((pane) => {
        const feed = feeds.get(pane.paneKey)
        return (
          now - (lastAttempt.get(pane.paneKey) ?? 0) >= UNRESOLVED_RETRY_MS &&
          (!feed || now - feed.resolvedAt >= RESOLVED_RECHECK_MS)
        )
      })
      for (const worktreeId of new Set(due.map((pane) => pane.worktreeId))) {
        const worktreePanes = due.filter((candidate) => candidate.worktreeId === worktreeId)
        for (const pane of worktreePanes) {
          lastAttempt.set(pane.paneKey, now)
        }
        let tabs: Tab[]
        try {
          tabs = await readWorktreeTabs(client, worktreeId)
        } catch {
          continue
        }
        for (const pane of worktreePanes) {
          const target = chatTargetForPane(tabs, pane.rawPaneKey)
          const feed = feeds.get(pane.paneKey)
          if (!target) {
            continue
          }
          if (feed && feed.client === client && feed.target.sessionId === target.sessionId) {
            feed.resolvedAt = now
            continue
          }
          if (feed) {
            drop(pane.paneKey, feed)
          }
          open(pane, hostId, client, target, now)
        }
      }
    },
    covers(paneKey) {
      return feeds.get(paneKey)?.baselined === true
    },
    heard,
    awaitReply(reply) {
      awaited.set(reply.id, { ...reply, polls: 0 })
    },
    overdue(feedsReading) {
      const due: AwaitedReply[] = []
      for (const [id, reply] of awaited) {
        reply.polls += 1
        const feed = feeds.get(reply.paneKey)
        if (heard(reply.paneKey, reply.text)) {
          awaited.delete(id)
          continue
        }
        if (feedsReading && feed?.baselined && reply.polls < FEED_GRACE_POLLS) {
          continue
        }
        awaited.delete(id)
        remember(reply.paneKey, reply.text)
        if (feed) {
          // Why: a feed that missed a reply may follow a session the pane has left; recheck it.
          feed.resolvedAt = Number.NEGATIVE_INFINITY
        }
        due.push({ id, paneKey: reply.paneKey, text: reply.text })
      }
      return due
    },
    keepHosts(hostIds) {
      for (const [paneKey, feed] of feeds) {
        if (!hostIds.has(feed.hostId)) {
          drop(paneKey, feed)
        }
      }
    },
    closeAll() {
      for (const [paneKey, feed] of feeds) {
        drop(paneKey, feed)
      }
      lastAttempt.clear()
    }
  }
}
