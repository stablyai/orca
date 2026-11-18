import { orderBotChats, type BotChatTreeChat } from '../../../src/shared/bots/bot-chat-tree'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { areStructurallyEqual } from '../worktree/catalog/structural-equality'
import { botChatTreeRead } from './use-phone-bot-chat-tree'

/** A bot's chats as the host list draws them. */
export type HostBotChatTree = {
  /** Home first, then waiting on you, replying, newest; closed last. */
  chats: BotChatTreeChat[]
  workspaceChats: Readonly<Record<string, string>>
}

/** By `hostBotTreeKey`; `loading` until a bot's first read lands. */
export type HostBotChatTrees = ReadonlyMap<string, HostBotChatTree | 'loading'>

export type WantedBotChatTree = { hostId: ExecutionHostId; botId: string; client: RpcClient }

/** The shortest gap between two reads of one bot's chats; a read asked sooner waits for it. */
export const BOT_CHAT_TREE_READ_GAP_MS = 1000

export function hostBotTreeKey(hostId: ExecutionHostId, botId: string): string {
  return `${hostId}\u0000${botId}`
}

/** Reads the wanted bots' chats, each at most once a gap; a late answer, or one for a bot no longer
 *  wanted, drops. A failed read keeps the last tree; a first one that fails lists the bot flat. */
export function startBotChatTreeReads(
  update: (apply: (previous: HostBotChatTrees) => HostBotChatTrees) => void,
  now: () => number = Date.now
) {
  const wanted = new Map<string, WantedBotChatTree>()
  const lastAt = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const asked = new Map<string, number>()

  const fire = (key: string): void => {
    const bot = wanted.get(key)
    if (!bot) {
      return
    }
    lastAt.set(key, now())
    const ask = (asked.get(key) ?? 0) + 1
    asked.set(key, ask)
    const current = () => asked.get(key) === ask && wanted.has(key)
    void botChatTreeRead
      .request(bot.client, { botId: bot.botId })
      .then((reply) => {
        if (current()) {
          const answer = readHostMethodReply(reply, botChatTreeRead.interpret)
          update((previous) =>
            answer.kind === 'answered'
              ? withTree(previous, key, answer.value)
              : withoutLoading(previous, key)
          )
        }
      })
      .catch(() => {
        if (current()) {
          update((previous) => withoutLoading(previous, key))
        }
      })
  }

  const read = (key: string): void => {
    if (!wanted.has(key) || timers.has(key)) {
      return
    }
    const wait = (lastAt.get(key) ?? -Infinity) + BOT_CHAT_TREE_READ_GAP_MS - now()
    if (wait <= 0) {
      fire(key)
      return
    }
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        fire(key)
      }, wait)
    )
  }

  const unwant = (key: string): void => {
    wanted.delete(key)
    clearTimeout(timers.get(key))
    timers.delete(key)
  }

  return {
    /** Sets the bots to read; a newly wanted one reads now, holding a loading row if none was read. */
    want(next: ReadonlyMap<string, WantedBotChatTree>): void {
      const added: string[] = []
      for (const key of wanted.keys()) {
        if (!next.has(key)) {
          unwant(key)
        }
      }
      for (const [key, bot] of next) {
        if (!wanted.has(key)) {
          added.push(key)
        }
        wanted.set(key, bot)
      }
      if (added.length === 0) {
        return
      }
      update((previous) => {
        const missing = added.filter((key) => !previous.has(key))
        if (missing.length === 0) {
          return previous
        }
        const loading = new Map(previous)
        missing.forEach((key) => loading.set(key, 'loading'))
        return loading
      })
      added.forEach(read)
    },
    /** Reads every wanted bot of the host that `which` keeps. */
    readWhere(which: (bot: WantedBotChatTree) => boolean): void {
      for (const [key, bot] of wanted) {
        if (which(bot)) {
          read(key)
        }
      }
    },
    stop(): void {
      for (const key of wanted.keys()) {
        unwant(key)
      }
    }
  }
}

function withTree(
  previous: HostBotChatTrees,
  key: string,
  value: { chats: BotChatTreeChat[]; workspaceChats: Readonly<Record<string, string>> }
): HostBotChatTrees {
  const chats = orderBotChats(value.chats)
  const prior = previous.get(key)
  const last = prior === 'loading' ? undefined : prior
  // An unchanged tree keeps the list as it is.
  if (
    last &&
    areStructurallyEqual(last.chats, chats) &&
    areStructurallyEqual(last.workspaceChats, value.workspaceChats)
  ) {
    return previous
  }
  const next = new Map(previous)
  next.set(key, { chats, workspaceChats: value.workspaceChats })
  return next
}

function withoutLoading(previous: HostBotChatTrees, key: string): HostBotChatTrees {
  if (previous.get(key) !== 'loading') {
    return previous
  }
  const next = new Map(previous)
  next.delete(key)
  return next
}
