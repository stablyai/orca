// How one run of an automation made answering a thread reaches that thread: which runs answer it,
// sending to the chat that answers it, and what the run is told.
import type {
  AutomationBotResultsTo,
  AutomationBotTarget
} from '../../shared/automations/automation-definition'
import type { AutomationOriginThread } from '../../shared/automation-bot-target'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRunMessage } from '../../shared/automations/automation-run-message'
import type { AutomationEventAsker } from './automation-event-prompt'
import { captureAutomationRunMessage } from './automation-run-message-capture'
import { automationRunMemoryLabel } from '../bots/bot-turn-source'
import { automationRunOperationId } from './launch/automation-run-operation'
import { automationResultsLine } from './bot-automation-thread-route'
import type { Bot } from '../../shared/bot-types'
import {
  automationResultsSentence,
  originThreadText
} from '../../shared/automations/automation-results-place'
import { LINEAR_ISSUE_KEY_PATTERN } from '../../shared/connector-bot-linear-contract'
import { BOT_QUIET_MARKER } from '../../shared/bot-quiet-result'
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
  return `[Orca: if you answer, begin your final message with this exact line, unchanged, then a blank line, then your answer; if you stay silent (${BOT_QUIET_MARKER}), leave it out: _From the automation “${automation.name}”, created in this thread._]`
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
    const thread = threadPlace(origin, routed.threadPost)
    const copy = routed.copyTo
      ? automationResultsSentence({ runsIn: 'new', resultsTo: routed.copyTo })
          .replace(/^Your final message posts as /, ', and a copy posts as ')
          .replace(/\.$/, '')
      : ''
    return `Your final message posts as a reply in ${thread}${copy}.`
  }
  // A thread it answers without a post is the event's own, bound to its conversation.
  return automationResultsSentence({
    runsIn: routed.runsIn,
    ...(routed.runsIn === 'chat' && target.chat ? { chat: target.chat } : {}),
    resultsTo: routed.resultsTo,
    ...(origin && routed.resultsTo !== 'thread' ? { originThread: origin } : {})
  })
}

/** A thread a run posts into, as people name it: the one it was made in, or the event's. */
export function threadPlace(
  origin: AutomationOriginThread | undefined,
  conversation: ConversationKey
): string {
  return sameConversation(origin, conversation) ? originThreadText(origin) : "the event's thread"
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

/** The run's message as one conversation takes it. In the thread's chat a wait is told to write its
 *  own first line; a new conversation standing in for that gone chat (fallback) is not, as Orca
 *  puts the line on its own post, and no longer claims the chat's thread turn. */
export function runMessage(
  automation: Automation,
  run: AutomationRun,
  prompt: string,
  asker: AutomationEventAsker | null,
  { fallback, inOriginChat }: { fallback: boolean; inOriginChat: boolean }
): { text: string; fields: BotRunFields; automationRun: AutomationRunMessage | undefined } {
  const resultsLine = automationResultsLine(automation, run)
  const text = [
    prompt,
    ...(resultsLine ? ['', resultsLine] : []),
    ...(!fallback && inOriginChat && automation.once && automation.bot?.chat?.toConversation
      ? ['', originProvenanceInstruction(automation)]
      : [])
  ].join('\n')
  const captured = captureAutomationRunMessage(automation, run, text, asker)
  const automationRun =
    captured && fallback ? (({ toConversation: _gone, ...rest }) => rest)(captured) : captured
  const fields: BotRunFields = {
    memorySource: automationRunMemoryLabel(automation.name, run.event),
    ...(run.triggeredBy ? { triggeredBy: run.triggeredBy } : {}),
    ...(automationRun ? { automationRun } : {}),
    messageId: automationRunOperationId(run, 'run-message')
  }
  return { text, fields, automationRun }
}
