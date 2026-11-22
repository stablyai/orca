// A connector conversation in a bot's home: a native chat there, checked against the bot on every delivery.
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import { directSlackRequester } from '../../shared/connector-asker-contract'
import type {
  ExternalConversationBot,
  ExternalConversationLink
} from '../../shared/connectors/external-conversation-link'
import { linkedChat, type LinkableChat } from './external-conversation-chat-delivery'
import { currentChat } from './external-conversation-chat'
import type {
  ExternalConversationHost,
  ExternalConversationSeamDeps
} from './external-conversation-host'
import { findLink, type ExternalConversationLinkStore } from './external-conversation-links'
import {
  freshSlackExecution,
  type OpenSlackExecution,
  type SlackExecutionRequest
} from './external-conversation-slack-execution'
import type { Bot } from '../../shared/bot-types'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  refused,
  type ConnectorMessage,
  type ConversationKey,
  type Delivery,
  type ReplyTarget
} from './external-conversation-types'

export type ConversationBots = {
  /** Why the bot takes no conversation now; null when it does. */
  refusal(botId: string): 'bot_not_found' | 'bot_paused' | null
  /** Whether the verified event's receiving workspace is also configured for this bot. */
  hasSlackWorkspace?(botId: string, teamId: string): boolean
  /** A host may provide this only when its launcher and memory tools enforce the requester scope. */
  openSlackExecution?(botId: string): OpenSlackExecution | undefined
  /** A new chat for a thread, or the bot's current Chat. */
  open(target: ExternalConversationBot): Promise<LinkableChat>
  /** The pull requests a bot conversation's work opened. */
  workLinks(link: ExternalConversationLink): Promise<ConnectorWorkLink[]>
}

/** A requester stamp can only enter a bot's journal through its configured Slack route. */
export function bindSlackRequester<T extends ConnectorMessage>(
  bots: ConversationBots | undefined,
  key: ConversationKey,
  bot: ExternalConversationBot | undefined,
  message: T
): T {
  if (!message.asker?.slackRequester) {
    return message
  }
  const { slackRequester, ...asker } = message.asker
  return key.source === 'slack' &&
    bot &&
    directSlackRequester(message.asker) &&
    bots?.hasSlackWorkspace?.(bot.botId, slackRequester.teamId) &&
    (message.later ?? []).every((delivery) => {
      const next = directSlackRequester(delivery.asker)
      return next?.teamId === slackRequester.teamId && next.userId === slackRequester.userId
    })
    ? message
    : { ...message, asker }
}

/**
 * The chat a bot conversation's delivery goes to, linked or not yet: a thread keeps the chat it started,
 * and a direct message goes to the bot's current Chat, which answers whoever wrote to it last.
 */
export async function botChatFor(
  store: ExternalConversationLinkStore,
  bots: ConversationBots | undefined,
  key: ConversationKey,
  bot: ExternalConversationBot,
  slack?: SlackExecutionRequest
): Promise<LinkableChat | Delivery> {
  if (!bots) {
    return refused('bot_not_found')
  }
  const refusal = bots.refusal(bot.botId)
  if (refusal) {
    return refused(refusal)
  }
  const open = key.source === 'slack' ? bots.openSlackExecution?.(bot.botId) : undefined
  if (open) {
    return slack?.message.reply
      ? freshSlackExecution({
          key,
          bot,
          message: bindSlackRequester(bots, key, bot, slack.message),
          open,
          linked: () => findLink(store, key),
          replacementReady: slack.replacementReady
        })
      : refused('agent_not_reachable')
  }
  // A DM that ran in the bot's Chat, then given its own chat, opens one rather than keep the Chat.
  const linked = findLink(store, key)
  if (linked?.link.isolatedSlack) {
    return refused('agent_not_reachable')
  }
  if (bot.kind === 'bot' && linked && linked.link.bot?.kind !== 'bot-chat') {
    return linkedChat(linked.workspace.worktreeId, linked.link)
  }
  return { ...(await bots.open(bot)), bot }
}

export function routeBotChat(
  deps: Pick<ExternalConversationSeamDeps, 'store' | 'repliesSettled'>,
  pending: (sessionId: string) => boolean
) {
  return (
    host: ExternalConversationHost,
    key: ConversationKey,
    bot: ExternalConversationBot,
    message: SlackExecutionRequest['message']
  ) =>
    botChatFor(deps.store, host.bots, key, bot, {
      message,
      replacementReady: async ({ sessionId, isolatedSlack, mirrorHeld, mirrorPosts }) => {
        const chat = currentChat(host.chat)
        if (
          !chat ||
          !isolatedSlack ||
          mirrorHeld?.length ||
          Object.values(mirrorPosts ?? {}).some(({ state }) => state === 'posting') ||
          pending(sessionId)
        ) {
          return false
        }
        if (!(await deps.repliesSettled?.(sessionId).catch(() => false))) {
          return false
        }
        const work =
          (await chat.currentWork(sessionId)) ??
          (await chat.currentWorkAtRest?.(sessionId).catch(() => null))
        return (
          !!work &&
          !work.working() &&
          !work.owesAnySend() &&
          !work.hasActionablePrompt() &&
          !pending(sessionId)
        )
      }
    })
}

/**
 * Why a bot's chat may not post a reply into its conversation; null when it may, or when it is no
 * bot's. A bot's Chat answers whichever direct message wrote last, so it has no one conversation to
 * post into mid-turn.
 */
export function botReplyRefusal(
  { bot: speaksFor, worktreeId }: ReplyTarget,
  bots: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]
): 'bot_chat_reply' | 'not_this_bots_conversation' | null {
  if (!speaksFor) {
    return null
  }
  if (speaksFor.kind === 'bot-chat') {
    return 'bot_chat_reply'
  }
  const bot = bots.find((entry) => entry.id === speaksFor.botId)
  return bot && folderWorkspaceKey(bot.folderWorkspaceId) === worktreeId
    ? null
    : 'not_this_bots_conversation'
}
