import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as z from 'zod'
import {
  orderBotChats,
  type BotChatTreeChat,
  type BotChatTreeRead,
  type BotChatTreeWorker
} from '../../../src/shared/bots/bot-chat-tree'
import { botChatTreeCursor, mergeShownFinished } from '../../../src/shared/bots/bot-chat-tree-model'
import {
  BotChatSearchResultSchema,
  BotChatTreeReadSchema
} from '../../../src/shared/bots/bot-chat-tree-schema'
import type { BotChatSearchAsk } from '../../../src/shared/bots/use-bot-chat-search'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

const botChatSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.chat-search-or-skip',
    method: 'bots.chats.search',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-chat-search', z.unknown().pipe(BotChatSearchResultSchema))
  })
)

export const botChatTreeRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.chat-tree-or-skip',
    method: 'bots.chatTree',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-chat-tree', z.unknown().pipe(BotChatTreeReadSchema))
  })
)

export type PhoneBotChatTree =
  /** Not answered yet: Activity shows a spinner. */
  | { kind: 'loading' }
  /** The first read failed: Activity says so, with Retry. */
  | { kind: 'failed'; retry: () => void }
  | {
      kind: 'tree'
      chats: BotChatTreeChat[]
      loadMore: (chatId: string) => void
      /** Asks the host to search every chat and worker. */
      search: BotChatSearchAsk
    }

/** The bot's chats with their workers from the host the route reaches (a paired server's too);
 *  re-read with the route's other reads while `showing`. */
export function usePhoneBotChatTree({
  client,
  botId,
  showing,
  reads
}: {
  client: RpcClient | null
  botId: string
  showing: boolean
  /** The route's read count: each botsChanged, reconnect or foreground read reads this too. */
  reads: number
}): PhoneBotChatTree {
  // `tree: undefined` until the host answers; null when its first read failed.
  const [read, setRead] = useState<{ botId: string; tree: BotChatTreeRead | null | undefined }>({
    botId,
    tree: undefined
  })
  // Finished workers shown past the host's newest, by chat.
  const [pages, setPages] = useState<{
    botId: string
    byChat: Record<string, BotChatTreeWorker[]>
  }>({ botId, byChat: {} })
  const loading = useRef(new Set<string>())
  const [attempt, setAttempt] = useState(0)
  // Retry shows the spinner again until the host answers.
  const retry = useCallback(() => {
    setRead((shown) => (shown.tree === null ? { botId: shown.botId, tree: undefined } : shown))
    setAttempt((count) => count + 1)
  }, [])

  useEffect(() => {
    if (!showing || !client) {
      return
    }
    let current = true
    // A failed read keeps what shows; a first one that fails says so.
    const settleFailed = () =>
      setRead((shown) =>
        shown.botId === botId && shown.tree !== undefined ? shown : { botId, tree: null }
      )
    void botChatTreeRead
      .request(client, { botId })
      .then((reply) => {
        const answer = readHostMethodReply(reply, botChatTreeRead.interpret)
        if (!current) {
          return
        }
        if (answer.kind === 'answered') {
          setRead({ botId, tree: answer.value })
        } else {
          settleFailed()
        }
      })
      .catch(() => {
        if (current) {
          settleFailed()
        }
      })
    return () => {
      current = false
    }
  }, [client, botId, showing, reads, attempt])

  const tree = read.botId === botId ? read.tree : undefined
  const byChat = pages.botId === botId ? pages.byChat : null
  const chats = useMemo(
    () =>
      tree
        ? orderBotChats(
            tree.chats.map((chat) => {
              const loaded = byChat?.[chat.chatId]
              return loaded
                ? { ...chat, finished: mergeShownFinished(chat.finished, loaded) }
                : chat
            })
          )
        : null,
    [tree, byChat]
  )

  const loadMore = useCallback(
    (chatId: string) => {
      if (!client || !chats || loading.current.has(chatId)) {
        return
      }
      const shown = chats.find((chat) => chat.chatId === chatId)?.finished ?? []
      const last = shown.at(-1)
      loading.current.add(chatId)
      void botChatTreeRead
        .request(client, {
          botId,
          chatId,
          ...(last ? { finishedAfter: botChatTreeCursor(last) } : {})
        })
        .then((reply) => {
          const answer = readHostMethodReply(reply, botChatTreeRead.interpret)
          const page = answer.kind === 'answered' ? answer.value.chats[0] : undefined
          if (!page) {
            return
          }
          setPages((current) => {
            const base = current.botId === botId ? current.byChat : {}
            // What was on screen stays, so a worker finishing between pages never drops one.
            return { botId, byChat: { ...base, [chatId]: [...shown, ...page.finished] } }
          })
        })
        .catch(() => {})
        .finally(() => loading.current.delete(chatId))
    },
    [client, botId, chats]
  )

  const search = useCallback<BotChatSearchAsk>(
    async (query) => {
      if (!client) {
        throw new Error('not_connected')
      }
      const answer = readHostMethodReply(
        await botChatSearchRead.request(client, { botId, query }),
        botChatSearchRead.interpret
      )
      if (answer.kind === 'answered') {
        return answer.value
      }
      throw new Error('search_failed')
    },
    [client, botId]
  )

  if (chats) {
    return { kind: 'tree', chats, loadMore, search }
  }
  return tree === undefined ? { kind: 'loading' } : { kind: 'failed', retry }
}
