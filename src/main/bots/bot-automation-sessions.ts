// Where a bot automation run's prompt goes: a new conversation in the bot's home, its Chat, or a chat it names.
import { randomUUID } from 'node:crypto'
import type { Bot } from '../../shared/bot-types'
import type { BotConversationActsFor } from '../runtime/orchestration/db/bot-requests/bot-conversation-acts-for-store'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { BotAutomationSessions } from '../automations/bot-automation-launch'
import type { BotRunSend } from './bot-run-turn-watch'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StructuredSessionTurnOutcome } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import {
  botMessageBody,
  runtimeBotChats,
  startBotSession,
  type BotRunFields,
  type botChatSessions
} from './bot-chat-session'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { chatIsIdle, stopChat } from '../external-conversations/external-conversation-chat'
import { botChatTakingMail } from '../runtime/rpc/methods/bots-chats'
import { botChatGone } from '../runtime/integrations/automations/runtime-automation-target'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import { sendBotGroupAutomationRun } from './bot-group-automation-run'
import { runtimeBotGroups } from './bot-group-runtime'

export type BotAutomationSessionDependencies = {
  chats: Pick<ReturnType<typeof botChatSessions>, 'sendToChat' | 'sendToSession'>
  /** The session running one of the bot's chats that takes mail; null when it is gone. */
  chatTakingMail: (bot: Bot, chatId: string) => Promise<{ sessionId: string } | null>
  /** A new conversation in the bot's home, started by the message; resolves to its session id. */
  startSession: (
    bot: Bot,
    message: { text: string; clientMessageId: string; run?: BotRunFields },
    actsFor: BotConversationActsFor,
    sessionId?: string,
    gates?: {
      beforeFirstMessage?: () => void | Promise<void>
      beforeDelivery?: () => boolean
    }
  ) => Promise<string>
  nameSession: (sessionId: string, name: string) => Promise<void>
  /** A run in a group room the bot is a member of, by its member session there. */
  sendToGroupRoom: (
    bot: Bot,
    sessionId: string,
    text: string,
    run?: BotRunFields
  ) => Promise<BotRunSend>
}

/** The Chat and message a send went to; throws when the Chat refused or rejected it. */
export function chatThatTookIt(sent: {
  sessionId: string
  outcome: StructuredSessionTurnOutcome
  fingerprint: string
}): BotRunSend {
  const { outcome } = sent
  if (outcome.kind === 'refused') {
    throw new Error(outcome.refusal.message)
  }
  if (outcome.kind === 'sent' && outcome.submission?.dispatchState === 'rejected') {
    throw new Error(outcome.submission.reason ?? "The bot's Chat did not take the prompt.")
  }
  return {
    sessionId: sent.sessionId,
    clientMessageId: outcome.clientMessageId,
    fingerprint: sent.fingerprint
  }
}

/** The Home Chat may be linked to another conversation: a wait's answer for its gone chat's thread
 *  must not post there. */
function withoutConversation(run: BotRunFields | undefined): BotRunFields | undefined {
  if (!run?.automationRun?.toConversation) {
    return run
  }
  const { toConversation: _dropped, ...automationRun } = run.automationRun
  return { ...run, automationRun }
}

export function botAutomationSessions(
  deps: BotAutomationSessionDependencies
): Omit<BotAutomationSessions, 'release'> {
  return {
    startConversation: async (
      bot,
      { text, title, sessionId: named, run, actsFor, beforeFirstMessage, beforeDelivery }
    ) => {
      const clientMessageId = run?.messageId ?? randomUUID()
      const sessionId = await deps.startSession(
        bot,
        { text, clientMessageId, ...(run ? { run } : {}) },
        actsFor,
        named,
        ...(beforeFirstMessage || beforeDelivery ? [{ beforeFirstMessage, beforeDelivery }] : [])
      )
      // The prompt is already in: a failed rename must not disown the run's session.
      await deps.nameSession(sessionId, title).catch((error: unknown) => {
        console.warn('[bots] could not name an automation conversation', error)
      })
      return {
        sessionId,
        clientMessageId,
        fingerprint: agentSessionSendBodyFingerprint(sessionId, botMessageBody(text))
      }
    },
    sendToBotChat: async (bot, chatId, text, run, homeIfGone) => {
      if (isBotGroupMemberSession(chatId)) {
        return deps.sendToGroupRoom(bot, chatId, text, run)
      }
      const chat = await deps.chatTakingMail(bot, chatId)
      if (!chat && homeIfGone) {
        return chatThatTookIt(
          await deps.chats.sendToChat(bot.id, text, undefined, withoutConversation(run))
        )
      }
      if (!chat) {
        throw new Error(botChatGone(bot.name, chatId))
      }
      return chatThatTookIt(await deps.chats.sendToSession(bot.id, chat.sessionId, text, run))
    },
    sendToSession: async (bot, sessionId, text, run) =>
      chatThatTookIt(await deps.chats.sendToSession(bot.id, sessionId, text, run)),
    sendToChat: async (bot, text, run) =>
      chatThatTookIt(await deps.chats.sendToChat(bot.id, text, undefined, run))
  }
}

export function runtimeBotAutomationSessions(runtime: OrcaRuntimeService): BotAutomationSessions {
  const sessions = botAutomationSessions({
    chats: runtimeBotChats(runtime),
    chatTakingMail: (bot, chatId) => botChatTakingMail(runtime, bot, chatId),
    startSession: (bot, message, actsFor, sessionId, gates) =>
      startBotSession(runtime, bot, {
        message,
        background: true,
        actsFor,
        ...gates,
        ...(sessionId ? { sessionId } : {})
      }),
    sendToGroupRoom: (bot, sessionId, text, run) =>
      sendBotGroupAutomationRun(runtimeBotGroups(runtime), bot, sessionId, text, run),
    // The start installed the host.
    nameSession: async (sessionId, name) => {
      await getStructuredAgentSessionHost()?.setUserConversationName(sessionId, name, 'rename')
    }
  })
  return {
    ...sessions,
    release: async (sessionId) => {
      await getStructuredAgentSessionHost()
        ?.releaseIdleSession(sessionId)
        .catch((error: unknown) => console.warn('[bots] could not release a finished run', error))
    }
  }
}

/** A bot conversation's turn, stopped with the chat's own Stop; no installed host runs none. */
export const botTurns = {
  stop: async (sessionId: string): Promise<void> => {
    await stopChat(getStructuredAgentSessionHost(), { sessionId })
  },
  running: (sessionId: string): boolean => !chatIsIdle(getStructuredAgentSessionHost(), sessionId)
}
