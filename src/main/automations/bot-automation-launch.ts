import type { Automation } from '../../shared/automations/automation-definition'
import { automationRunMemoryLabel } from '../bots/bot-turn-source'
import { automationRunOperationId } from './launch/automation-run-operation'
import type { LinkableChat } from '../external-conversations/external-conversation-chat-delivery'
import type { ConversationKey } from '../external-conversations/external-conversation-types'
import type { Bot } from '../../shared/bot-types'
import { OWNER_ACTS_FOR } from '../../shared/bots/bot-acts-for'
import type { BotConversationActsFor } from '../runtime/orchestration/db/bot-requests/bot-conversation-acts-for-store'
import type { AutomationBotLauncher } from './launch/automation-launch'
import type { BotRunCompletion, BotRunResult } from '../bots/bot-run-results'
import type { BotRunSend, BotTurnWatch } from '../bots/bot-run-turn-watch'
import {
  automationDeadlinePrompt,
  automationEventAsker,
  automationRunPrompt
} from './automation-event-prompt'
import { captureAutomationRunMessage } from './automation-run-message-capture'
import type { BotRunFields } from '../bots/bot-chat-session'
import type { AgentJournalAutomationRunNotStartedItem } from '../../shared/agent-journal-orca-card-items'
import { BotSessionRefusedError } from '../bots/bot-session-refused-error'
import { originChatOf } from '../../shared/automation-bot-target'
import { originThreadText } from '../../shared/automations/automation-results-place'
import { runRoutes } from './bot-run-thread-posts'
import {
  automationResultsLine,
  missedItsThread,
  threadResults,
  threadRoute,
  type ThreadRoute
} from './bot-automation-thread-route'
export { automationResultsLine, missedItsThread }
import {
  answersOriginThread,
  effectiveResultsSentence,
  originProvenanceInstruction,
  sameConversation,
  sendToOpenOriginChat
} from './bot-automation-origin-run'

/** Where a bot run's prompt goes; each resolves to the structured session and message that took it. */
export type BotAutomationSessions = {
  /** A new conversation in the bot's home, opened by the text; `sessionId` when the caller names it first. */
  startConversation(
    bot: Bot,
    input: {
      text: string
      title: string
      sessionId?: string
      run?: BotRunFields
      /** Admission after session preparation, right before its opening message; throws to refuse. */
      beforeFirstMessage?: () => void | Promise<void>
      /** Asked synchronously right before delivery can start; false withdraws the message. */
      beforeDelivery?: () => boolean
      /** Recorded before the conversation starts. */
      actsFor: BotConversationActsFor
    }
  ): Promise<BotRunSend>
  /** One of the bot's chats by its id from `orca bot chats`; when it is gone, the bot's Chat with
   *  `homeIfGone`, else refused. */
  sendToBotChat(
    bot: Bot,
    chatId: string,
    text: string,
    run?: BotRunFields,
    homeIfGone?: boolean
  ): Promise<BotRunSend>
  /** A chat of the bot's by its session, behind its running turn. */
  sendToSession(bot: Bot, sessionId: string, text: string, run?: BotRunFields): Promise<BotRunSend>
  /** Stops the agent of a finished run's own conversation now, unless someone watches it or it owes
   *  work; replying later resumes it. Never rejects. */
  release(sessionId: string): Promise<void>
  /** The bot's Chat, created on first use. */
  sendToChat(bot: Bot, text: string, run?: BotRunFields): Promise<BotRunSend>
  /** Whether one of the bot's chats still takes mail; absent, it is taken to. */
  takesMail?(bot: Bot, chatId: string): Promise<boolean>
  /** One of the bot's chats by its id, or null when it is gone: never the bot's Chat instead. */
  sendToOpenChat?(
    bot: Bot,
    chatId: string,
    text: string,
    run?: BotRunFields
  ): Promise<BotRunSend | null>
}

/** How a bot run ends: watch its turn from before the prompt is sent, then deliver its result. */
export type BotRunResults = {
  watch(): Promise<BotTurnWatch>
  deliver(result: BotRunResult): Promise<BotRunCompletion>
  /** Its session refused the prompt or couldn't open, so no turn began. With `notStarted`, the chat
   *  the run was meant for (else the bot's Chat) shows the card. */
  couldNotStart(
    bot: Bot,
    automation: Pick<Automation, 'name'>,
    notStarted?: { destination: BotRunChat; card: AgentJournalAutomationRunNotStartedItem }
  ): void
}

/** The chat a run's prompt goes to: a session, one of the bot's chats by id, or its Chat (also where a
 *  run's new conversation is reported when it never opened). */
export type BotRunChat =
  | { kind: 'session'; sessionId: string }
  | { kind: 'bot-chat'; chatId: string }
  | { kind: 'chat' }

// Shown word for word; bounded like the chat's other recorded errors.
const MAX_NOT_STARTED_ERROR_LENGTH = 2000

function notStartedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, MAX_NOT_STARTED_ERROR_LENGTH)
}

/** Links a run's chat to the cloud conversation its event came in; false when it couldn't. */
export type BotRunThreads = {
  adopt(conversation: ConversationKey, chat: LinkableChat, text: string): boolean
  /** The chat linked here to a thread's owning conversation; 'gone' once that chat was deleted,
   *  null when no chat here answers it. */
  ownerChat?(conversation: ConversationKey): Promise<LinkableChat | 'gone' | null>
  /** Tells the cloud a conversation's chat is gone, so its thread is free. */
  release?(conversation: ConversationKey): void
}

/** The run completes when the turn its prompt started ends, after its result is delivered. */
export function createBotAutomationDispatcher(
  sessions: BotAutomationSessions,
  results: BotRunResults,
  threads?: BotRunThreads
): AutomationBotLauncher {
  return async ({ automation, run, target }) => {
    const turns = await results.watch()
    const asker = run.event ? automationEventAsker(run.event, target.bot.members) : null
    const prompt =
      automation.once?.by !== undefined && run.trigger === 'scheduled'
        ? automationDeadlinePrompt(
            automation.prompt,
            automation.once.by,
            Boolean(automation.on?.length)
          )
        : automationRunPrompt(automation.prompt, run.event, asker)
    const chosenChat = automation.bot?.chat?.sessionId
    const origin = automation.bot?.originThread
    const originKey = origin && { source: origin.source, externalId: origin.externalId }
    const originChat = originChatOf(automation.bot)
    const inOriginChat =
      originChat !== undefined && target.runsIn === 'chat' && chosenChat === originChat
    // The message as one conversation takes it: in the thread's chat, a wait writes its own first
    // line; anywhere else Orca puts that line on the post itself.
    const messageFor = (inThreadChat: boolean) => {
      const resultsLine = automationResultsLine(automation, run)
      const text = [
        prompt,
        ...(resultsLine ? ['', resultsLine] : []),
        ...(inThreadChat && automation.once && automation.bot?.chat?.toConversation
          ? ['', originProvenanceInstruction(automation)]
          : [])
      ].join('\n')
      const automationRun = captureAutomationRunMessage(automation, run, text, asker)
      const unlinked =
        automationRun && !inThreadChat && inOriginChat
          ? (({ toConversation: _gone, ...rest }) => rest)(automationRun)
          : automationRun
      const fields: BotRunFields = {
        memorySource: automationRunMemoryLabel(automation.name, run.event),
        ...(run.triggeredBy ? { triggeredBy: run.triggeredBy } : {}),
        ...(unlinked ? { automationRun: unlinked } : {}),
        messageId: automationRunOperationId(run, 'run-message')
      }
      return { text, fields, automationRun: unlinked }
    }
    let message = messageFor(inOriginChat)
    const couldNotStart = (error: unknown, destination: BotRunChat): never => {
      turns.dispose()
      results.couldNotStart(
        target.bot,
        automation,
        message.automationRun && {
          destination,
          card: {
            kind: 'automation-run-not-started',
            run: message.automationRun,
            actsFor: [...OWNER_ACTS_FOR],
            error: notStartedError(error),
            ...(error instanceof BotSessionRefusedError ? { refusal: error.data.refusal } : {}),
            text: message.text,
            at: Date.now()
          }
        }
      )
      throw error
    }
    // Sent where the thread's chat still takes it; gone before or while it went, a new
    // conversation posts the result into the thread instead, never the bot's Chat.
    let send: BotRunSend | null = null
    let originGone = false
    if (inOriginChat && sessions.sendToOpenChat) {
      try {
        send = await sendToOpenOriginChat(
          sessions,
          target.bot,
          originChat,
          message.text,
          message.fields
        )
      } catch (error) {
        couldNotStart(error, { kind: 'bot-chat', chatId: originChat })
      }
      originGone = send === null
    }
    if (originGone) {
      message = messageFor(false)
    }
    const runsIn = originGone ? 'new' : target.runsIn
    const savedTo = automation.bot?.resultsTo ?? 'chat'
    const saved = originGone ? 'thread' : savedTo
    // A channel or issue named besides the thread still gets its copy.
    const copyTo = originGone && typeof savedTo === 'object' ? savedTo : undefined
    const route: ThreadRoute =
      saved === 'thread'
        ? await threadRoute(
            threads,
            run,
            runsIn,
            originGone || answersOriginThread(run) ? originKey : undefined
          )
        : { kind: 'take' }
    // A new conversation that never opened has no chat to show why: the bot's Chat does.
    const destination: BotRunChat =
      route.kind === 'owner'
        ? { kind: 'session', sessionId: route.chat.sessionId }
        : runsIn === 'chat' && chosenChat
          ? { kind: 'bot-chat', chatId: chosenChat }
          : { kind: 'chat' }
    try {
      send ??=
        destination.kind === 'session'
          ? await sessions.sendToSession(
              target.bot,
              destination.sessionId,
              message.text,
              message.fields
            )
          : destination.kind === 'bot-chat'
            ? await sessions.sendToBotChat(
                target.bot,
                destination.chatId,
                message.text,
                message.fields,
                automation.bot?.chat?.homeIfGone
              )
            : runsIn === 'chat'
              ? await sessions.sendToChat(target.bot, message.text, message.fields)
              : await sessions.startConversation(target.bot, {
                  text: message.text,
                  title: run.title,
                  run: message.fields,
                  actsFor: {
                    // Its owner: the event is content, whoever made the automation.
                    actsFor: [...OWNER_ACTS_FOR],
                    ...(run.triggeredBy ? { triggeredBy: run.triggeredBy } : {})
                  }
                })
    } catch (error) {
      couldNotStart(error, destination)
    }
    const sent = send!
    // A run in the owning chat waits behind its running turn, so its result is posted through the
    // owning conversation, never by marking a turn that may be another's.
    const resultsTo =
      route.kind === 'owner' || route.kind === 'post'
        ? 'thread'
        : saved === 'thread'
          ? threadResults(
              threads,
              run,
              {
                worktreeId: target.workspaceId,
                sessionId: sent.sessionId,
                agent: target.bot.agent,
                bot: { kind: 'bot', botId: target.bot.id }
              },
              run.title
            )
          : saved
    const threadPost = route.kind === 'take' ? undefined : route.conversation
    // Its replies while it works go where this run's result goes, not where the saved target would.
    const unlisted = automation.bot
      ? runRoutes.start(sent.sessionId, {
          botId: target.bot.id,
          ...(route.kind === 'post'
            ? {
                threadPost: {
                  conversation: route.conversation,
                  place: sameConversation(origin, route.conversation)
                    ? originThreadText(origin)
                    : "the event's thread"
                }
              }
            : {}),
          sentence: effectiveResultsSentence(automation.bot, {
            runsIn,
            resultsTo,
            threadPost,
            copyTo
          })
        })
      : () => {}
    return {
      sessionKind: 'chat',
      workspaceId: target.workspaceId,
      workspaceDisplayName: target.bot.name,
      terminalSessionId: null,
      chatSessionId: sent.sessionId,
      completion: turns
        .next(sent)
        .then((ended) =>
          results.deliver({
            automation,
            run,
            bot: target.bot,
            target: {
              runsIn,
              resultsTo,
              letBotReact: automation.bot?.letBotReact === true,
              ...(threadPost ? { threadPost } : {}),
              ...(copyTo ? { copyTo } : {})
            },
            sessionId: sent.sessionId,
            ended
          })
        )
        .finally(() => {
          unlisted()
          // Only a conversation the run started is its own to release.
          if (route.kind !== 'owner' && runsIn === 'new') {
            void sessions.release(sent.sessionId)
          }
        })
    }
  }
}
