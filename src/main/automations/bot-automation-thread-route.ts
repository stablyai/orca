// Where a bot run that answers in a thread sends its result: the chat that owns the event's thread,
// a chat of its own that takes it, or a post into it, and what its wake note says of it.
import type {
  Automation,
  AutomationBotResultsTo
} from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { LINEAR_ISSUE_KEY_PATTERN } from '../../shared/connector-bot-linear-contract'
import { runResultsSentence } from '../../shared/automations/automation-results-place'
import type { LinkableChat } from '../external-conversations/external-conversation-chat-delivery'
import type { ConversationKey } from '../external-conversations/external-conversation-types'
import type { BotRunThreads } from './bot-automation-launch'

/** Where a run that answers in its event's thread goes: into the chat that owns the thread, its own
 *  chat that takes the thread, or a chat that leaves the thread alone and posts its result there. */
export type ThreadRoute =
  | { kind: 'owner'; conversation: ConversationKey; chat: LinkableChat }
  | { kind: 'take' }
  | { kind: 'post'; conversation: ConversationKey }

export async function threadRoute(
  threads: BotRunThreads | undefined,
  run: Pick<AutomationRun, 'event' | 'trigger'>,
  runsIn: 'new' | 'chat',
  origin?: ConversationKey
): Promise<ThreadRoute> {
  const { event } = run
  // Made answering a thread, and this run answers there (answersOriginThread): its result goes there.
  if (origin) {
    return { kind: 'post', conversation: origin }
  }
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
export function threadResults(
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

/** The wake note's last line: where the run's final message goes. Run by hand, a thread's run is in
 *  no thread, so its result stays in its conversation. */
export function automationResultsLine(
  automation: Pick<Automation, 'bot'>,
  run: Pick<AutomationRun, 'trigger'>
): string | null {
  const target = automation.bot
  if (!target) {
    return null
  }
  return `[Orca: ${runResultsSentence(target, run.trigger)}]`
}

/** An event run meant for its thread that got none: no thread on the event, or an older cloud. */
export function missedItsThread(
  automation: Pick<Automation, 'bot'>,
  run: Pick<AutomationRun, 'trigger'>,
  resultsTo: AutomationBotResultsTo
): boolean {
  return resultsTo === 'none' && automation.bot?.resultsTo === 'thread' && run.trigger === 'event'
}
