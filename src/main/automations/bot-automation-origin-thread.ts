// An automation a bot's turn makes while it answers a thread answers under that thread: the person
// asked there, so its result belongs there, never as a new post beside it in the same channel.
// Decided once its places are refs, on create and on every edit of its target.
import {
  originChatOf,
  type AutomationBotTarget,
  type AutomationOriginThread
} from '../../shared/automation-bot-target'
import { originThreadText } from '../../shared/automations/automation-results-place'
import { isRefOf, legacyPlaceOf } from '../../shared/connector-place-names'
import { slackPlaceOf } from '../../shared/connectors/slack-mirror-state'

type ResultChannel = { channel: string; ref?: string }

/** Whether results name the thread's own channel, by workspace and channel id: the ref the host
 *  saved (slack:T0123:C0123), or the bare id an older cloud keeps, which names no workspace. */
export function namesThreadChannel(place: ResultChannel, thread: AutomationOriginThread): boolean {
  const origin = thread.source === 'slack' ? slackPlaceOf(thread.externalId) : null
  if (!origin) {
    return false
  }
  if (place.ref && isRefOf('slack', place.ref)) {
    const [, teamId, channelId] = place.ref.split(':')
    return teamId === origin.teamId && channelId === origin.channelId
  }
  return legacyPlaceOf('slack', place.channel) === origin.channelId
}

/** Results sent somewhere else by name go there, not to the thread. */
function sentElsewhere(
  target: AutomationBotTarget,
  thread: AutomationOriginThread,
  originChat: string | undefined
): boolean {
  const { resultsTo } = target
  if (resultsTo === 'none') {
    return true
  }
  if (typeof resultsTo === 'object') {
    return 'linearIssue' in resultsTo || !namesThreadChannel(resultsTo, thread)
  }
  // Another chat chosen by id keeps a result that stays in Orca there.
  return (
    resultsTo === 'chat' &&
    target.runsIn === 'chat' &&
    target.chat !== undefined &&
    target.chat.sessionId !== originChat
  )
}

/**
 * Where an automation with no events, made answering a thread, runs and answers. It answers under
 * that thread unless its results go to another place by name: in the chat that made it, so `bot
 * reply` posts there mid-run and the final message is the chat's own answer; or, when it can't run
 * there (its own agent, another chat chosen by id, or that chat is gone), by posting its result
 * into the thread. One that events start keeps their threads; it only remembers its own.
 */
export function routeToOriginThread(
  target: AutomationBotTarget,
  options: {
    hasEvents: boolean
    /** The chat that made it, as the host looked it up: null once gone, undefined when not looked up. */
    originChat?: { title: string | null } | null
  }
): AutomationBotTarget {
  const thread = target.originThread
  const originChat = originChatOf(target)
  if (!thread || options.hasEvents || sentElsewhere(target, thread, originChat)) {
    return target
  }
  const otherChat = target.runsIn === 'chat' && target.chat && target.chat.sessionId !== originChat
  if (target.agentSetup || otherChat) {
    return { ...target, resultsTo: 'thread' }
  }
  // That chat is gone, or Orca never knew it: a new conversation posts into the thread.
  if (!originChat || options.originChat === null) {
    const { chat: _gone, ...rest } = target
    return { ...rest, runsIn: 'new', resultsTo: 'thread' }
  }
  const title = options.originChat?.title ?? target.chat?.title
  return {
    ...target,
    runsIn: 'chat',
    chat: {
      sessionId: originChat,
      ...(title ? { title } : {}),
      homeIfGone: true,
      toConversation: true
    },
    resultsTo: 'chat',
    // Kept on the thread, so later edits and runs find the chat without the chat field.
    originThread: { ...thread, sessionId: originChat }
  }
}

/** The create or edit output's note when the thread overrode flags the caller gave; null otherwise. */
export function originThreadNote(
  asked: AutomationBotTarget,
  saved: AutomationBotTarget | undefined,
  given: { runsIn: boolean; resultsTo: boolean }
): string | null {
  const thread = saved?.originThread
  const inThread =
    saved?.resultsTo === 'thread' ||
    (saved?.runsIn === 'chat' && saved.chat?.toConversation === true)
  if (!thread || !inThread) {
    return null
  }
  const flags = [
    ...(given.runsIn &&
    (asked.runsIn !== saved.runsIn || asked.chat?.sessionId !== saved.chat?.sessionId)
      ? ['--runs-in']
      : []),
    ...(given.resultsTo &&
    typeof asked.resultsTo === 'object' &&
    typeof saved.resultsTo !== 'object'
      ? ['--results-to']
      : [])
  ]
  if (flags.length === 0) {
    return null
  }
  const how = saved.runsIn === 'chat' ? 'runs in this chat and replies' : 'posts its result'
  const why = flags.includes('--results-to')
    ? " (--results-to named this thread's own channel)"
    : ''
  return `Made while answering ${originThreadText(thread)}, so it ${how} there: this overrode ${flags.join(' and ')}${why}. To post in a different channel instead, name that channel with --results-to channel:<channel>.`
}
