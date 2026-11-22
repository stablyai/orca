// `bots.chats.search`: every chat and worker of a bot, matched on its host. Names come from one chats-tree
// read; conversation text comes from the host's session search index when the owner turned it on.
import type { BotChatTreeChat, BotChatTreeWorker } from '../../shared/bots/bot-chat-tree'
import { orderBotChats } from '../../shared/bots/bot-chat-tree'
import {
  botChatTreeDispatchWorker,
  type BotChatTreePlaced
} from '../../shared/bots/bot-chat-tree-model'
import {
  BOT_CHAT_SEARCH_LIMIT,
  matchBotChats,
  type BotChatSearchResult,
  type BotChatSearchWorker
} from '../../shared/bots/bot-chat-search'
import type { Bot } from '../../shared/bot-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { OrchestrationSessionWorker } from '../../shared/orchestration-session-workers'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { BotChatSearchParams } from '../../shared/rpc-contract/bots-params'
import { searchSessionService } from '../ai-vault-search/session-search-service-registry'
import { sessionSearchPolicy } from '../ai-vault-search/session-search-policy'
import { searchWithStructuredOwners } from '../ai-vault/structured-sessions/structured-session-ownership'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { SESSION_SEARCH_LIMIT_MAX } from '../../shared/ai-vault/search/ai-vault-search-limit'
import {
  readBotChatTreeParts,
  runtimeBotChatTreeHost,
  type BotChatTreeHost,
  type BotChatTreeParts
} from './bot-chat-tree-host'

export type BotChatSearchHost = BotChatTreeHost & {
  /** The bot's chats-tree read the search matches against. */
  treeParts: (botId: string) => Promise<BotChatTreeParts>
  /** Native chats whose conversation text matches, from the session search index; [] when it is off. */
  contentMatches: (bot: Bot, query: string) => Promise<readonly string[]>
}

/** A typing burst searches at each pause; the tree read behind it is the costly part, so one serves this long. */
export const BOT_CHAT_SEARCH_TREE_REUSE_MS = 5_000

/** Reuses each bot's tree read for the searches within `BOT_CHAT_SEARCH_TREE_REUSE_MS`; a failed read isn't kept. */
export function recentBotChatTreeParts(
  read: (botId: string) => Promise<BotChatTreeParts>
): (botId: string) => Promise<BotChatTreeParts> {
  const recent = new Map<string, { at: number; parts: Promise<BotChatTreeParts> }>()
  return (botId) => {
    const now = Date.now()
    for (const [id, entry] of recent) {
      if (now - entry.at > BOT_CHAT_SEARCH_TREE_REUSE_MS) {
        recent.delete(id)
      }
    }
    const kept = recent.get(botId)
    if (kept) {
      return kept.parts
    }
    const entry = { at: now, parts: read(botId) }
    recent.set(botId, entry)
    entry.parts.catch(() => {
      if (recent.get(botId) === entry) {
        recent.delete(botId)
      }
    })
    return entry.parts
  }
}

type BotChatSearchIndex = {
  chats: BotChatTreeChat[]
  byId: ReadonlyMap<string, BotChatTreeChat>
  /** The worker rows the tree drew, by key. */
  shown: ReadonlyMap<string, BotChatTreeWorker>
  workers: BotChatSearchWorker[]
  placedByKey: ReadonlyMap<string, BotChatTreePlaced>
  rootOf: (sessionId: string) => string
}

const indexes = new WeakMap<BotChatTreeParts, BotChatSearchIndex>()

/** What a search matches against, built once per tree read so a typing burst's searches share it. */
function searchIndexOf(parts: BotChatTreeParts): BotChatSearchIndex {
  const kept = indexes.get(parts)
  if (kept) {
    return kept
  }
  const { tree, placed, rootOf } = parts
  const chats = orderBotChats(tree.chats)
  const shown = new Map(
    chats.flatMap((chat) => [...chat.running, ...chat.finished].map((w) => [w.key, w] as const))
  )
  // Every placed Dispatch by its Task's title, plus the rows the tree drew that no Dispatch places.
  const workers = [
    ...placed.map((entry) => ({
      key: `worker:${entry.dispatch.id}`,
      chatId: entry.chatId,
      title: entry.dispatch.title ?? shown.get(`worker:${entry.dispatch.id}`)?.title ?? ''
    })),
    ...chats.flatMap((chat) =>
      [...chat.running, ...chat.finished]
        .filter((worker) => !worker.key.startsWith('worker:'))
        .map((worker) => ({ key: worker.key, chatId: chat.chatId, title: worker.title }))
    )
  ]
  const index = {
    chats,
    byId: new Map(chats.map((chat) => [chat.chatId, chat])),
    shown,
    workers,
    placedByKey: new Map(placed.map((entry) => [`worker:${entry.dispatch.id}`, entry])),
    rootOf
  }
  indexes.set(parts, index)
  return index
}

export async function searchBotChats(
  host: Pick<BotChatSearchHost, 'bots' | 'treeParts' | 'contentMatches' | 'dispatchWorkers'>,
  params: BotChatSearchParams
): Promise<BotChatSearchResult> {
  const bot = host.bots().find((entry) => entry.id === params.botId)
  if (!bot) {
    throw new Error('bot_not_found')
  }
  const [parts, content] = await Promise.all([
    host.treeParts(bot.id),
    host.contentMatches(bot, params.query).catch(() => [])
  ])
  const { chats, byId, shown, workers, placedByKey, rootOf } = searchIndexOf(parts)
  const { matches, more } = matchBotChats(chats, workers, params.query, {
    limit: params.limit ?? BOT_CHAT_SEARCH_LIMIT,
    contentChatIds: new Set(content.map(rootOf))
  })

  // Matching workers the tree didn't draw (older finished ones) are read here, and only those.
  const missing = matches.flatMap((match) =>
    (match.workerKeys ?? []).filter((key) => !shown.has(key))
  )
  const records: readonly OrchestrationSessionWorker[] = await host
    .dispatchWorkers(missing.flatMap((key) => placedByKey.get(key)?.dispatch.id ?? []))
    .catch(() => [])
  const recordById = new Map(records.map((record) => [record.dispatchId, record]))
  const rowOf = (key: string): BotChatTreeWorker | null => {
    const entry = placedByKey.get(key)
    return (
      shown.get(key) ??
      (entry ? botChatTreeDispatchWorker(entry, recordById.get(entry.dispatch.id)) : null)
    )
  }
  return {
    chats: matches.flatMap((match) => {
      const chat = byId.get(match.chatId)
      if (!chat || !match.workerKeys) {
        return chat ? [chat] : []
      }
      const rows = match.workerKeys.flatMap((key) => rowOf(key) ?? [])
      const live = (row: BotChatTreeWorker) => row.state !== 'done' && row.state !== 'failed'
      const running = rows.filter(live)
      const finished = rows.filter((row) => !live(row))
      // A worker match lists only those workers, and counts only them: no Show more it can't fill.
      return [
        {
          ...chat,
          running,
          runningTotal: running.length,
          finished,
          finishedTotal: finished.length,
          failedTotal: finished.filter((row) => row.state === 'failed').length
        }
      ]
    }),
    matches,
    more
  }
}

/** The bot home's native chats whose text matches, searched in the home's folder; none while the index is off. */
export async function indexedChatMatches(
  runtime: {
    listFolderWorkspaces: () => readonly Pick<FolderWorkspace, 'id' | 'folderPath'>[]
    ensureStructuredAgentSessionHost: () => Promise<unknown>
  },
  bot: Bot,
  query: string
): Promise<string[]> {
  // Off means not even asked: asking starts the index child process.
  if (!sessionSearchPolicy().enabled) {
    return []
  }
  const home = runtime.listFolderWorkspaces().find((folder) => folder.id === bot.folderWorkspaceId)
  if (!home) {
    return []
  }
  const workspaceId = folderWorkspaceKey(home.id)
  const response = await searchWithStructuredOwners(
    searchSessionService(
      { query, limit: SESSION_SEARCH_LIMIT_MAX, filters: { scopePaths: [home.folderPath] } },
      'ipc'
    ),
    { ensureHost: () => runtime.ensureStructuredAgentSessionHost(), opensChat: () => true }
  )
  return response.kind === 'results'
    ? response.hits.flatMap((hit) =>
        hit.structuredSession?.workspaceId === workspaceId ? [hit.structuredSession.sessionId] : []
      )
    : []
}

const treePartsByRuntime = new WeakMap<
  OrcaRuntimeService,
  (botId: string) => Promise<BotChatTreeParts>
>()

export function runtimeBotChatSearchHost(runtime: OrcaRuntimeService): BotChatSearchHost {
  let treeParts = treePartsByRuntime.get(runtime)
  if (!treeParts) {
    treeParts = recentBotChatTreeParts((botId) =>
      readBotChatTreeParts(runtimeBotChatTreeHost(runtime), { botId })
    )
    treePartsByRuntime.set(runtime, treeParts)
  }
  return {
    ...runtimeBotChatTreeHost(runtime),
    treeParts,
    contentMatches: (bot, query) => indexedChatMatches(runtime, bot, query)
  }
}
