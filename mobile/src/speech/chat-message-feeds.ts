import { z } from 'zod'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '../../../src/shared/native-chat-agent-support'
import { buildNativeChatSubscriptionId } from '../../../src/shared/native-chat/native-chat-stream-unsubscribe'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import { sessionTabsListRead } from '../session/mobile-session-read-operations'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import type { RpcClient } from '../transport/rpc-client'
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

type ChatTarget = { agent: string; sessionId: string; transcriptPath: string | null }

const tabSchema = z.looseObject({
  type: z.string(),
  id: z.string(),
  parentTabId: z.string().nullish(),
  leafId: z.string().nullish(),
  launchAgent: z.string().nullish(),
  agentStatus: z
    .looseObject({
      agentType: z.string().nullish(),
      providerSession: z
        .looseObject({ id: z.string().nullish(), transcriptPath: z.string().nullish() })
        .nullish()
    })
    .nullish()
})
type Tab = z.infer<typeof tabSchema>

const frameSchema = z.looseObject({
  type: z.string().optional(),
  pending: z.boolean().optional(),
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

function tabsOf(result: unknown): Tab[] {
  const tabs = z.looseObject({ tabs: z.array(z.unknown()) }).safeParse(result)
  if (!tabs.success) {
    return []
  }
  return tabs.data.tabs.flatMap((tab) => {
    const parsed = tabSchema.safeParse(tab)
    return parsed.success ? [parsed.data] : []
  })
}

/** The transcript a terminal pane's chat reads, by the rules of `resolveMobileNativeChat`. */
export function chatTargetForPane(tabs: readonly Tab[], rawPaneKey: string): ChatTarget | null {
  const pane = parsePaneKey(rawPaneKey)
  if (!pane) {
    return null
  }
  const tab = tabs.find(
    (candidate) =>
      candidate.type === 'terminal' &&
      (candidate.parentTabId ?? candidate.id) === pane.tabId &&
      candidate.leafId === pane.leafId
  )
  if (!tab) {
    return null
  }
  const liveAgent = tab.agentStatus?.agentType ?? null
  const agent = liveAgent ?? tab.launchAgent ?? null
  // Why: agents without a host transcript reader are left to final replies.
  if (!agent || !isNativeChatSupportedAgent(agent) || nativeChatRequiresLocalTranscript(agent)) {
    return null
  }
  const sessionId = tab.agentStatus?.providerSession?.id
  if (!sessionId) {
    return null
  }
  return {
    agent,
    sessionId,
    transcriptPath: tab.agentStatus?.providerSession?.transcriptPath ?? null
  }
}

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

type Feed = {
  hostId: string
  target: ChatTarget
  resolvedAt: number
  close: () => void
  seen: Set<string>
  baselined: boolean
  pendingBase: boolean
  turnStartedAt: number | null
}

export type ChatMessageFeeds = {
  sync(hostId: string, client: RpcClient, panes: readonly AgentPane[], now: number): Promise<void>
  /** Whether this pane's messages are reaching the reader through a feed. */
  covers(paneKey: string): boolean
  /** Whether this reply was already spoken from the feed. */
  heard(paneKey: string, text: string): boolean
  closeAll(): void
}

/** `speak` answers whether it read the message, which is what `heard` remembers. */
export function createChatMessageFeeds(
  speak: (paneKey: string, messageId: string, text: string) => boolean
): ChatMessageFeeds {
  const feeds = new Map<string, Feed>()
  const lastAttempt = new Map<string, number>()
  const spoken = new Map<string, string[]>()

  const announce = (paneKey: string, messages: readonly FrameMessage[]) => {
    for (const message of messages) {
      const text = assistantText(message)
      if (text && speak(paneKey, message.id, text)) {
        const heardKeys = [sameMessageKey(text), ...(spoken.get(paneKey) ?? [])]
        spoken.set(paneKey, heardKeys.slice(0, MAX_REMEMBERED))
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
        if (feed.hostId === hostId && !present.has(paneKey)) {
          drop(paneKey, feed)
        }
      }
      const due = panes.filter((pane) => {
        const feed = feeds.get(pane.paneKey)
        return feed
          ? now - feed.resolvedAt >= RESOLVED_RECHECK_MS
          : now - (lastAttempt.get(pane.paneKey) ?? 0) >= UNRESOLVED_RETRY_MS
      })
      for (const worktreeId of new Set(due.map((pane) => pane.worktreeId))) {
        let tabs: Tab[]
        try {
          const response = await sessionTabsListRead.request(client, {
            worktree: `id:${worktreeId}`
          })
          tabs = tabsOf(sessionTabsListRead.interpret(response))
        } catch {
          continue
        }
        for (const pane of due.filter((candidate) => candidate.worktreeId === worktreeId)) {
          lastAttempt.set(pane.paneKey, now)
          const target = chatTargetForPane(tabs, pane.rawPaneKey)
          const feed = feeds.get(pane.paneKey)
          if (!target) {
            continue
          }
          if (feed && feed.target.sessionId === target.sessionId) {
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
    heard(paneKey, text) {
      return (spoken.get(paneKey) ?? []).includes(sameMessageKey(text))
    },
    closeAll() {
      for (const [paneKey, feed] of feeds) {
        drop(paneKey, feed)
      }
      lastAttempt.clear()
    }
  }
}
