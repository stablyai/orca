// How one run of an automation made answering a thread reaches that thread: which runs answer it,
// sending to the chat that answers it, and what the run is told.
import type {
  AutomationBotResultsTo,
  AutomationBotTarget
} from '../../shared/automations/automation-definition'
import type { AutomationOriginThread } from '../../shared/automation-bot-target'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Bot } from '../../shared/bot-types'
import {
  automationResultsSentence,
  originThreadText
} from '../../shared/automations/automation-results-place'
import { LINEAR_ISSUE_KEY_PATTERN } from '../../shared/connector-bot-linear-contract'
import type { BotRunFields } from '../bots/bot-chat-session'
import type { BotRunSend } from '../bots/bot-run-turn-watch'
import type { ConversationKey } from '../external-conversations/external-conversation-types'
import type { BotAutomationSessions } from './bot-automation-launch'

/** Whether a run answers the thread its automation was made in rather than one of its own: a
 *  schedule or deadline always does, an event only when it brought no thread or Linear issue, and a
 *  run by hand never does. */
export function answersOriginThread(run: Pick<AutomationRun, 'event' | 'trigger'>): boolean {
  if (run.trigger === 'manual') {
    return false
  }
  if (run.trigger !== 'event') {
    return true
  }
  const { event } = run
  const linearIssue =
    event?.source === 'linear' &&
    event.subject !== undefined &&
    LINEAR_ISSUE_KEY_PATTERN.test(event.subject)
  return !event?.conversation && !linearIssue
}

/** The prompt to the chat that answers the thread; null when that chat is gone, even if it closed
 *  while the prompt went. Any other failure is the run's. */
export async function sendToOpenOriginChat(
  sessions: BotAutomationSessions,
  bot: Bot,
  chatId: string,
  text: string,
  run: BotRunFields
): Promise<BotRunSend | null> {
  try {
    return await sessions.sendToOpenChat!(bot, chatId, text, run)
  } catch (error) {
    if (sessions.takesMail && !(await sessions.takesMail(bot, chatId))) {
      return null
    }
    throw error
  }
}

/** A wait's run answering in its thread's chat opens its answer with where it came from: the chat's
 *  own answer is the thread post, so the run writes the line Orca would have put first. */
export function originProvenanceInstruction(automation: { name: string }): string {
  return `[Orca: start your final message with this line, as written: _From the automation “${automation.name}”, created in this thread._]`
}

/** What a run's live replies and refusals say of its final message: where this run's result goes
 *  as it was routed, never what the saved automation would do for another run. */
export function effectiveResultsSentence(
  target: AutomationBotTarget,
  routed: {
    runsIn: AutomationBotTarget['runsIn']
    resultsTo: AutomationBotResultsTo
    threadPost?: ConversationKey
    copyTo?: Extract<AutomationBotResultsTo, object>
  }
): string {
  const origin = target.originThread
  if (routed.threadPost) {
    const thread = sameConversation(origin, routed.threadPost)
      ? originThreadText(origin)
      : "the event's thread"
    const copy = routed.copyTo
      ? automationResultsSentence({ runsIn: 'new', resultsTo: routed.copyTo })
          .replace(/^Your final message posts as /, ', and a copy posts as ')
          .replace(/\.$/, '')
      : ''
    return `Your final message posts as a reply in ${thread}${copy}.`
  }
  return automationResultsSentence({
    runsIn: routed.runsIn,
    ...(routed.runsIn === 'chat' && target.chat ? { chat: target.chat } : {}),
    resultsTo: routed.resultsTo,
    ...(origin ? { originThread: origin } : {})
  })
}

/** Whether a conversation is the thread the automation was made in, by source and id. */
export function sameConversation(
  origin: { source: string; externalId: string } | undefined,
  conversation: ConversationKey
): origin is NonNullable<typeof origin> & AutomationOriginThread {
  return (
    origin !== undefined &&
    origin.source === conversation.source &&
    origin.externalId === conversation.externalId
  )
}
