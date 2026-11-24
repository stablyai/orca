// What a bot's waiting chats' own sessions ask, read from the host's status feed.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import * as z from 'zod'
import type { AgentSessionStatusSummary } from '../../../../src/shared/agent-session/agent-session-wire'
import type { BotChatTreeChat } from '../../../../src/shared/bots/bot-chat-tree'
import { useOptionalHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { structuredAgentSessionHostSupport } from '../../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import { mobileStructuredSessionStatusFeed } from '../../session/native-chat/agent-session/mobile-structured-session-status-feed'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

const noSubscription = (): (() => void) => () => {}

/** What a waiting chat's session asks, as its host's status feed says, and whether it waits at all. */
export type PhoneChatPrompt = Pick<
  AgentSessionStatusSummary,
  'awaitsApproval' | 'awaitsBlockingQuestion'
> & { own: boolean }

// The waiting chats' prompts as `useChatPrompts` reads them: [session id, prompt] pairs.
const ChatPrompts = z.array(
  z.tuple([
    z.string(),
    z.object({
      awaitsApproval: z.object({ tool: z.string(), input: z.string().optional() }).optional(),
      awaitsBlockingQuestion: z.object({ text: z.string() }).optional(),
      own: z.boolean()
    })
  ])
)

/** The session whose status is the chat's: the one a /clear moved it to, else its own. */
export function chatSessionId(chat: BotChatTreeChat): string {
  return chat.liveSessionId ?? chat.chatId
}

/** The approval or question each waiting chat's session waits on, and whether it waits at all (the
 *  tree may mark Home for a paired server's card), as its host's status feed says; none on a host
 *  without it. Read as one string, so other sessions' frames re-render nothing. */
export function useChatPrompts(
  client: RpcClient | null,
  chats: readonly BotChatTreeChat[] | null
): (chat: BotChatTreeChat) => PhoneChatPrompt | undefined {
  const capabilities = useOptionalHostProtocolGates()?.hostCapabilities
  const statusFeed = useMemo(
    () => structuredAgentSessionHostSupport(capabilities ?? []).statusFeed,
    [capabilities]
  )
  const feed = client && statusFeed ? mobileStructuredSessionStatusFeed(client) : null
  const waiting = useMemo(
    () => (chats ?? []).filter((chat) => chat.live === 'needs-you').map(chatSessionId),
    [chats]
  )
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const read = useCallback(() => {
    const snapshot = feed?.getSnapshot()
    return JSON.stringify(
      waiting.flatMap((id) => {
        const status = snapshot?.get(id)
        if (!status) {
          return []
        }
        const { awaitsApproval, awaitsBlockingQuestion } = status
        const own = status.status === 'attention' || status.awaitsAnswer === true
        return [[id, { awaitsApproval, awaitsBlockingQuestion, own }]]
      })
    )
  }, [feed, waiting])
  const prompts = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => {
    const byId = new Map(ChatPrompts.parse(JSON.parse(prompts)))
    return (chat: BotChatTreeChat) => byId.get(chatSessionId(chat))
  }, [prompts])
}
