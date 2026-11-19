import type {
  Automation,
  AutomationBotResultsTo
} from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { automationRunMemoryLabel } from '../bots/bot-turn-source'
import { LINEAR_ISSUE_KEY_PATTERN } from '../../shared/connector-bot-linear-contract'
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

/** Where a run that answers in its event's thread goes: into the chat that owns the thread, its own
 *  chat that takes the thread, or a chat that leaves the thread alone and posts its result there. */
type ThreadRoute =
  | { kind: 'owner'; conversation: ConversationKey; chat: LinkableChat }
  | { kind: 'take' }
  | { kind: 'post'; conversation: ConversationKey }

async function threadRoute(
  threads: BotRunThreads | undefined,
  run: Pick<AutomationRun, 'event' | 'trigger'>,
  runsIn: 'new' | 'chat'
): Promise<ThreadRoute> {
  const { event } = run
  if (run.trigger !== 'event' || !event?.conversation) {
    return { kind: 'take' }
  }
  // The Chat or a chosen chat answers many threads, so a run there never takes this one.
  if (runsIn === 'chat') {
    return { kind: 'post', conversation: event.conversation }
  }
  const owner = event.threadOwner && (await threads?.ownerChat?.(event.threadOwner.conversation))
  if (!event.threadOwner || !owner) {
    return { kind: 'take' }
  }
  if (owner === 'gone') {
    threads?.release?.(event.threadOwner.conversation)
    return { kind: 'take' }
  }
  return { kind: 'owner', conversation: event.threadOwner.conversation, chat: owner }
}

/**
 * Where a run that answers in the event's thread sends its result. A linked Slack or GitHub thread
 * posts the final message itself; a Linear issue takes it as the bot's comment. Run now replays the
 * last event for its prompt only, so it, and an event the cloud bound to no thread, keeps the result
 * in its own conversation.
 */
function threadResults(
  threads: BotRunThreads | undefined,
  run: Pick<AutomationRun, 'event' | 'trigger'>,
  chat: LinkableChat,
  title: string
): AutomationBotResultsTo {
  const { event } = run
  if (run.trigger === 'manual') {
    return 'none'
  }
  if (event?.source === 'linear' && event.subject && LINEAR_ISSUE_KEY_PATTERN.test(event.subject)) {
    return { linearIssue: event.subject }
  }
  return event?.conversation && threads?.adopt(event.conversation, chat, title) ? 'thread' : 'none'
}

/** An event run meant for its thread that got none: no thread on the event, or an older cloud. */
export function missedItsThread(
  automation: Pick<Automation, 'bot'>,
  run: Pick<AutomationRun, 'trigger'>,
  resultsTo: AutomationBotResultsTo
): boolean {
  return resultsTo === 'none' && automation.bot?.resultsTo === 'thread' && run.trigger === 'event'
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
    const text =
      automation.once?.by !== undefined && run.trigger === 'scheduled'
        ? automationDeadlinePrompt(
            automation.prompt,
            automation.once.by,
            Boolean(automation.on?.length)
          )
        : automationRunPrompt(automation.prompt, run.event, asker)
    const automationRun = captureAutomationRunMessage(automation, run, text, asker)
    const fields: BotRunFields = {
      memorySource: automationRunMemoryLabel(automation.name, run.event),
      ...(run.triggeredBy ? { triggeredBy: run.triggeredBy } : {}),
      ...(automationRun ? { automationRun } : {})
    }
    const { runsIn } = target
    const chosenChat = automation.bot?.chat?.sessionId
    const saved = automation.bot?.resultsTo ?? 'chat'
    const route: ThreadRoute =
      saved === 'thread' ? await threadRoute(threads, run, runsIn) : { kind: 'take' }
    // A new conversation that never opened has no chat to show why: the bot's Chat does.
    const destination: BotRunChat =
      route.kind === 'owner'
        ? { kind: 'session', sessionId: route.chat.sessionId }
        : runsIn === 'chat' && chosenChat
          ? { kind: 'bot-chat', chatId: chosenChat }
          : { kind: 'chat' }
    let send: BotRunSend
    try {
      send =
        destination.kind === 'session'
          ? await sessions.sendToSession(target.bot, destination.sessionId, text, fields)
          : destination.kind === 'bot-chat'
            ? await sessions.sendToBotChat(
                target.bot,
                destination.chatId,
                text,
                fields,
                automation.bot?.chat?.homeIfGone
              )
            : runsIn === 'chat'
              ? await sessions.sendToChat(target.bot, text, fields)
              : await sessions.startConversation(target.bot, {
                  text,
                  title: run.title,
                  run: fields,
                  actsFor: {
                    // Its owner: the event is content, whoever made the automation.
                    actsFor: [...OWNER_ACTS_FOR],
                    ...(run.triggeredBy ? { triggeredBy: run.triggeredBy } : {})
                  }
                })
    } catch (error) {
      turns.dispose()
      results.couldNotStart(
        target.bot,
        automation,
        automationRun && {
          destination,
          card: {
            kind: 'automation-run-not-started',
            run: automationRun,
            actsFor: [...OWNER_ACTS_FOR],
            error: notStartedError(error),
            text,
            at: Date.now()
          }
        }
      )
      throw error
    }
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
                sessionId: send.sessionId,
                agent: target.bot.agent,
                bot: { kind: 'bot', botId: target.bot.id }
              },
              run.title
            )
          : saved
    return {
      sessionKind: 'chat',
      workspaceId: target.workspaceId,
      workspaceDisplayName: target.bot.name,
      terminalSessionId: null,
      chatSessionId: send.sessionId,
      completion: turns
        .next(send)
        .then((ended) =>
          results.deliver({
            automation,
            run,
            bot: target.bot,
            target: {
              runsIn,
              resultsTo,
              letBotReact: automation.bot?.letBotReact === true,
              ...(route.kind === 'take' ? {} : { threadPost: route.conversation })
            },
            sessionId: send.sessionId,
            ended
          })
        )
        .finally(() => {
          // Only a conversation the run started is its own to release.
          if (route.kind === 'take' && runsIn === 'new') {
            void sessions.release(send.sessionId)
          }
        })
    }
  }
}
