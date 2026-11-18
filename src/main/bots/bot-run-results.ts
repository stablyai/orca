// A bot automation run's result: when its turn ends, its last message goes to the bot's Chat, a channel, a Linear issue, or nowhere.
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import type {
  Automation,
  AutomationBotTarget
} from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Bot } from '../../shared/bot-types'
import {
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorBotPostAnswer,
  type ConnectorTurnFor
} from '../../shared/connectors/connector-cloud-contract'
import { botTurnFor } from './bot-turn-for'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import { capUtf8 } from '../connector-cloud/connector-turn-events'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'
import type { ConnectorBotPostBody } from '../connector-cloud/connector-replies'
import type { ConversationKey } from '../external-conversations/external-conversation-types'
import type { AutomationLaunch } from '../automations/launch/automation-launch'
import type { BotRunResults } from '../automations/bot-automation-launch'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  alertBotCouldNotStart,
  BOT_COULD_NOT_FINISH_COPY,
  botRunRefusalAlerts,
  notifyBotCouldNotFinish,
  runtimeBotOwnerNotice,
  type BotOwnerNoticeDeps
} from './bot-could-not-finish'
import { chatThatTookIt } from './bot-automation-sessions'
import { missedItsThread } from '../automations/bot-automation-launch'
import { requireStructuredHost, runtimeBotChats } from './bot-chat-session'
import { runtimeBotRunNotStarted, showBotRunNotStarted } from './bot-run-not-started'
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import * as resultNote from './bot-run-result-note'
import { writeStructuredAgentSessionOrcaNote } from '../native-chat/agent-session-wire/structured-agent-session-orca-note'
import { resultPlaceValue } from '../automations/bot-automation-place-refs'
import { watchBotTurnEnds, type BotRunUnavailable, type BotTurnEnd } from './bot-run-turn-watch'

export type BotRunCompletion = Awaited<NonNullable<AutomationLaunch['completion']>>

export type BotRunDeliveryDependencies = BotOwnerNoticeDeps &
  resultNote.BotRunNoteDependencies & {
    sendToChat(bot: Bot, text: string, from: AgentMessageSource): Promise<unknown>
    /** Null when Orca Cloud is not connected. */
    postAsBot(
      bot: Bot,
      body: ConnectorBotPostBody
    ): Promise<ConnectorResult<ConnectorBotPostAnswer>> | null
    /** This host is signed out of Orca, so nothing posts through Orca Cloud. */
    cloudSignedOut(): boolean
    /** An Orca note in the run's own conversation, where its result shows. */
    noteToRun(sessionId: string, noteId: string, text: string): Promise<unknown>
    /** The bot's words in an event's thread through the run's own cloud conversation, linking no
     *  chat; null when Orca Cloud is not connected. */
    replyInThread(
      conversation: ConversationKey,
      replyId: string,
      text: string,
      turnFor: ConnectorTurnFor
    ): Promise<ConnectorResult<{ notices?: string[] }>> | null
    /** Whom the run's conversation acts for, so its Slack post counts as them (bot-turn-for.ts). */
    turnForOf(sessionId: string): Promise<ConnectorTurnFor>
  }

export type BotRunResult = {
  automation: Pick<Automation, 'id' | 'name' | 'dtstart' | 'bot'>
  run: Pick<AutomationRun, 'id' | 'trigger'>
  bot: Bot
  target: Pick<AutomationBotTarget, 'runsIn' | 'resultsTo' | 'letBotReact'> & {
    /** A run that answers in its event's thread without taking it: its result is posted there. */
    threadPost?: ConversationKey
  }
  /** The conversation the run went to. */
  sessionId: string
  ended: BotTurnEnd
}

/** The run's conversation as the Chat shows the sender of its result. */
function runSender(sessionId: string, name: string): AgentMessageSource {
  return {
    kind: 'agent',
    senders: isOrcaSessionId(sessionId)
      ? [
          {
            party: {
              address: formatOrcaSessionAddress(sessionId),
              terminalHandle: null,
              orcaSessionId: sessionId
            },
            name
          }
        ]
      : [],
    orchestration: null
  }
}

const COPY = {
  failed: (outcome: string) => `The bot's turn ended without finishing (${outcome}).`,
  chatResult: (automation: string, message: string) => `Result of "${automation}":\n\n${message}`,
  cloudOff: "Orca Cloud isn't connected, so the result wasn't posted.",
  signedOut: (place: string) => `Not posted to ${place}: this computer is signed out of Orca.`,
  postFailed: "The result couldn't be posted.",
  chatFailed: "The result couldn't be sent to the bot's Chat.",
  notInThread:
    "Orca Cloud didn't link this event to a thread, so the result stayed in this run's conversation.",
  unavailable: {
    removed:
      "This run's message was removed from the Chat before it was sent, so no result was sent.",
    edited: "This run's message was edited in the Chat before it was sent, so no result was sent.",
    shared:
      "This run's message was answered together with another message, so its result wasn't posted.",
    unattributed:
      "Orca couldn't tell which reply in the Chat was this run's, so no result was sent.",
    unread: "Orca couldn't read how this run's turn ended, so no result was sent."
  } satisfies Record<BotRunUnavailable, string>
}

/** Delivers a finished run's result and says how the run ended. */
export async function deliverBotRunResult(
  deps: BotRunDeliveryDependencies,
  result: BotRunResult
): Promise<BotRunCompletion> {
  const { automation, bot, target, ended } = result
  // result_unavailable: never another turn's answer in its place.
  if ('unavailable' in ended) {
    return { status: 'dispatch_failed', error: COPY.unavailable[ended.unavailable] }
  }
  if (ended.outcome !== 'success') {
    notifyBotCouldNotFinish(
      deps,
      bot,
      automation,
      {
        title: BOT_COULD_NOT_FINISH_COPY.title(bot.name),
        body: BOT_COULD_NOT_FINISH_COPY.turnEnded(automation.name),
        phone: false
      },
      result.sessionId
    )
    const error = COPY.failed(ended.outcome)
    await resultNote.leave(deps, result, 'couldNotFinish', ended.message.trim() || error)
    return { status: 'dispatch_failed', error }
  }
  const message = ended.message.trim()
  const completed: BotRunCompletion = {
    status: 'completed',
    outputSnapshot: message
      ? { format: 'plain_text', content: message, capturedAt: Date.now(), truncated: false }
      : null
  }
  const { resultsTo } = target
  if (message && !isQuietBotResult(message) && missedItsThread(automation, result.run, resultsTo)) {
    return { ...completed, error: COPY.notInThread }
  }
  if (message && !isQuietBotResult(message) && resultsTo === 'thread' && target.threadPost) {
    const text = capUtf8(message, CONNECTOR_CLIENT_LIMITS.maxLastAssistantMessageBytes)
    const posted = await deps.replyInThread(
      target.threadPost,
      `run-result:${result.run.id}`,
      text,
      await deps.turnForOf(result.sessionId)
    )
    if (!posted?.ok) {
      return { ...completed, error: posted ? COPY.postFailed : COPY.cloudOff }
    }
    await noteNotices(deps, result, posted.value.notices)
    return completed
  }
  // A run in the Chat already left its result there; one linked to its event's thread posts it there.
  if (
    !message ||
    isQuietBotResult(message) ||
    resultsTo === 'none' ||
    resultsTo === 'thread' ||
    (resultsTo === 'chat' && target.runsIn === 'chat')
  ) {
    return completed
  }
  if (resultNote.takesNote(target)) {
    return { ...completed, ...(await resultNote.leave(deps, result, 'finished', message)) }
  }
  if (resultsTo === 'chat') {
    try {
      await deps.sendToChat(
        bot,
        COPY.chatResult(automation.name, message),
        runSender(result.sessionId, automation.name)
      )
      return completed
    } catch (error) {
      console.warn('[bots] could not send a run result to the Chat', error)
      return { ...completed, error: COPY.chatFailed }
    }
  }
  const text = capUtf8(message, CONNECTOR_CLIENT_LIMITS.maxLastAssistantMessageBytes)
  const postId = result.run.id
  // The ref where the host saved one; the id or key where it saved only that.
  const place = resultPlaceValue(resultsTo)
  // Said where the result shows, not only in run history afterwards.
  if (deps.cloudSignedOut()) {
    const error = COPY.signedOut('channel' in resultsTo ? 'Slack' : 'Linear')
    await deps
      .noteToRun(result.sessionId, `result-not-posted:${result.run.id}`, error)
      .catch((noteError: unknown) =>
        console.warn('[bots] could not note an unposted result in its run', noteError)
      )
    return { ...completed, error }
  }
  const turnFor = 'channel' in resultsTo ? await deps.turnForOf(result.sessionId) : undefined
  const posted = await deps.postAsBot(
    bot,
    resultsTo.ref
      ? { postId, ref: resultsTo.ref, text, ...(turnFor ? { turnFor } : {}) }
      : 'channel' in resultsTo
        ? { postId, channelId: place, text, ...(turnFor ? { turnFor } : {}) }
        : { postId, issue: place, text }
  )
  if (!posted?.ok) {
    return { ...completed, error: posted ? COPY.postFailed : COPY.cloudOff }
  }
  await noteNotices(deps, result, posted.value?.notices)
  return completed
}

// Why the result can't wake an Orca bot it mentions, said in the run where it shows.
async function noteNotices(
  deps: BotRunDeliveryDependencies,
  result: BotRunResult,
  notices: readonly string[] | undefined
): Promise<void> {
  if (!notices?.length) {
    return
  }
  await deps
    .noteToRun(result.sessionId, `result-notices:${result.run.id}`, notices.join('\n'))
    .catch((noteError: unknown) =>
      console.warn('[bots] could not note a result’s notices in its run', noteError)
    )
}

export function runtimeBotRunRefusals(
  runtime: OrcaRuntimeService
): (automation: Pick<Automation, 'name' | 'bot'>, error: string) => void {
  return botRunRefusalAlerts(runtimeBotOwnerNotice(runtime), () => runtime.bots.list())
}

export function runtimeBotRunResults(runtime: OrcaRuntimeService): BotRunResults {
  const chats = runtimeBotChats(runtime)
  return {
    watch: async () => watchBotTurnEnds(await requireStructuredHost(runtime)),
    couldNotStart: (bot, automation, notStarted) => {
      alertBotCouldNotStart(runtimeBotOwnerNotice(runtime), bot, automation)
      if (notStarted) {
        void showBotRunNotStarted(
          runtimeBotRunNotStarted(runtime, chats),
          bot,
          notStarted.destination,
          notStarted.card
        )
      }
    },
    deliver: (result) =>
      deliverBotRunResult(
        {
          sendToChat: async (bot, text, from) =>
            chatThatTookIt(await chats.sendToChat(bot.id, text, from)),
          noteToChat: resultNote.runtimeNoteToChat(runtime, chats),
          postAsBot: (bot, body) => runtime.getConnectorCloud()?.postAsBot(bot.id, body) ?? null,
          cloudSignedOut: () => runtime.getConnectorCloud()?.status() === 'signed-out',
          noteToRun: async (sessionId, noteId, text) =>
            writeStructuredAgentSessionOrcaNote(
              await requireStructuredHost(runtime),
              sessionId,
              noteId,
              { kind: 'status', text }
            ),
          replyInThread: (conversation, replyId, text, turnFor) =>
            runtime
              .getConnectorCloud()
              ?.reply({ replyId, conversation, turnId: Date.now(), text, turnFor }) ?? null,
          turnForOf: (sessionId) => botTurnFor(runtime, sessionId, undefined),
          ...runtimeBotOwnerNotice(runtime)
        },
        result
      )
  }
}
