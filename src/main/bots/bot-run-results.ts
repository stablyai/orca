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
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import { capAnswer } from '../connector-cloud/connector-snapshot'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'
import type { ConnectorBotPostBody } from '../connector-cloud/connector-replies'
import type { ConversationKey } from '../external-conversations/external-conversation-types'
import type { AutomationLaunch } from '../automations/launch/automation-launch'
import {
  BOT_COULD_NOT_FINISH_COPY,
  notifyBotCouldNotFinish,
  type BotOwnerNoticeDeps
} from './bot-could-not-finish'
import { missedItsThread } from '../automations/bot-automation-launch'
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import type { SlackAnswerPresentation } from '../../shared/connectors/slack-answer-presentation'
import { matchingSlackPresentation } from '../connector-cloud/connector-slack-text'
import { structuredAgentSessionRefusalLine } from '../../shared/agent-session/requests/structured-agent-session-turn-failure'
import { tuiAgentDisplayName } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import { ANSWERED_TOGETHER_NOTICE } from '../../shared/automations/history/automation-run-answered-together'
import * as resultNote from './bot-run-result-note'
import { resultPlaceValue } from '../automations/bot-automation-place-refs'
import type { BotRunUnavailable, BotTurnEnd } from './bot-run-turn-watch'
import {
  hostNotSignedIn,
  serverSignInSteps,
  type OrcaSignInServer
} from '../../shared/bots/host-orca-sign-in'

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
    /** This host's name when it is a headless server, whose signed-out note says how it signs in. */
    signInServer?(): OrcaSignInServer
    /** An Orca note in the run's own conversation, where its result shows. */
    noteToRun(sessionId: string, noteId: string, text: string): Promise<unknown>
    /** The bot's words in an event's thread through the run's own cloud conversation, linking no
     *  chat; null when Orca Cloud is not connected. */
    replyInThread(
      conversation: ConversationKey,
      replyId: string,
      text: string,
      turnFor: ConnectorTurnFor,
      presentation?: SlackAnswerPresentation
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
  signedOut: (place: string, server: OrcaSignInServer, botName: string) => {
    const steps = serverSignInSteps(server, botName, 'owner')
    return steps
      ? `Not posted to ${place}. ${hostNotSignedIn(server)}. ${steps}`
      : `Not posted to ${place}: this computer isn't signed in to Orca Cloud.`
  },
  postFailed: "The result couldn't be posted.",
  chatFailed: "The result couldn't be sent to the bot's Chat.",
  notInThread:
    "Orca Cloud didn't link this event to a thread, so the result stayed in this run's conversation.",
  unavailable: {
    removed:
      "This run's message was removed from the Chat before it was sent, so no result was sent.",
    edited: "This run's message was edited in the Chat before it was sent, so no result was sent.",
    shared: ANSWERED_TOGETHER_NOTICE,
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
  if ('unavailable' in ended && ended.unavailable === 'shared') {
    // Its prompt was handled in that turn; only its own result post is skipped.
    return { status: 'completed', outputSnapshot: null, error: COPY.unavailable.shared }
  }
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
    const why =
      ended.error ??
      structuredAgentSessionRefusalLine(ended.refusal, tuiAgentDisplayName(bot.agent) ?? undefined)
    return { status: 'dispatch_failed', error: why ?? error }
  }
  const message = ended.message.trim()
  const presentation =
    ended.presentation && matchingSlackPresentation(ended.presentation, message)
      ? ended.presentation
      : undefined
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
    if (ended.presentation === null && target.threadPost.source === 'slack') {
      return { ...completed, error: COPY.postFailed }
    }
    const text = capAnswer(message, CONNECTOR_CLIENT_LIMITS.maxLastAssistantMessageBytes)
    const posted = await deps.replyInThread(
      target.threadPost,
      `run-result:${result.run.id}`,
      text,
      await deps.turnForOf(result.sessionId),
      ...(presentation && target.threadPost.source === 'slack' && text === message
        ? ([presentation] as const)
        : [])
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
  const text = capAnswer(message, CONNECTOR_CLIENT_LIMITS.maxLastAssistantMessageBytes)
  const postId = result.run.id
  // The ref where the host saved one; the id or key where it saved only that.
  const place = resultPlaceValue(resultsTo)
  // Said where the result shows, not only in run history afterwards.
  if (deps.cloudSignedOut()) {
    const error = COPY.signedOut(
      'channel' in resultsTo ? 'Slack' : 'Linear',
      deps.signInServer?.(),
      bot.name
    )
    await deps
      .noteToRun(result.sessionId, `result-not-posted:${result.run.id}`, error)
      .catch((noteError: unknown) =>
        console.warn('[bots] could not note an unposted result in its run', noteError)
      )
    return { ...completed, error }
  }
  if (ended.presentation === null && 'channel' in resultsTo) {
    return { ...completed, error: COPY.postFailed }
  }
  const turnFor = 'channel' in resultsTo ? await deps.turnForOf(result.sessionId) : undefined
  const slackPresentation =
    'channel' in resultsTo && presentation && text === message ? { presentation } : {}
  const posted = await deps.postAsBot(
    bot,
    resultsTo.ref
      ? { postId, ref: resultsTo.ref, text, ...(turnFor ? { turnFor } : {}), ...slackPresentation }
      : 'channel' in resultsTo
        ? { postId, channelId: place, text, ...(turnFor ? { turnFor } : {}), ...slackPresentation }
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
