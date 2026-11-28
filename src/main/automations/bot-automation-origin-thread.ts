// An automation a bot's turn makes, with no events, while it answers a Slack thread answers under
// that thread: the person asked there, so its result belongs there, never as a new post beside it in
// the same channel. Decided once its places are refs, on create and on every edit of its target.
import type {
  AutomationBotTarget,
  AutomationOriginThread
} from '../../shared/automation-bot-target'
import { originThreadText } from '../../shared/automations/automation-results-place'
import { isRefOf } from '../../shared/connector-place-names'
import { slackPlaceOf } from '../../shared/connectors/slack-mirror-state'

/** Whether results name the thread's own channel: the ref the host saved (slack:T0123:C0123) has
 *  the thread's workspace and channel. A place with no ref names no workspace, so it never does. */
export function namesThreadChannel(
  place: { channel: string; ref?: string },
  thread: AutomationOriginThread
): boolean {
  const origin = thread.source === 'slack' ? slackPlaceOf(thread.externalId) : null
  if (!origin || !place.ref || !isRefOf('slack', place.ref)) {
    return false
  }
  const [, teamId, channelId] = place.ref.split(':')
  return teamId === origin.teamId && channelId === origin.channelId
}

/** Results the caller sent somewhere else by name: they go there, not to the thread. */
function sentElsewhere(target: AutomationBotTarget, thread: AutomationOriginThread): boolean {
  const { resultsTo } = target
  if (resultsTo === 'none') {
    return true
  }
  if (typeof resultsTo === 'object') {
    return 'linearIssue' in resultsTo || !namesThreadChannel(resultsTo, thread)
  }
  return resultsTo === 'chat' && otherChat(target, thread)
}

/** It runs in one of the bot's chats the caller chose by id, other than the thread's. */
function otherChat(target: AutomationBotTarget, thread: AutomationOriginThread): boolean {
  return (
    target.runsIn === 'chat' &&
    target.chat !== undefined &&
    target.chat.sessionId !== thread.sessionId
  )
}

/**
 * Where an automation with no events, made answering a thread, runs and answers. Unless its results
 * go to another place by name, it runs in the chat that made it, whose answer is the thread's reply
 * and where `bot reply` posts mid-run. One that can't run there (its own agent, or another chat
 * chosen by id) keeps its results in Orca rather than post beside the thread in its channel.
 */
export function routeToOriginThread(
  target: AutomationBotTarget,
  options: { hasEvents: boolean; originChat?: { title: string | null } | null }
): AutomationBotTarget {
  const thread = target.originThread
  if (!thread || options.hasEvents || sentElsewhere(target, thread)) {
    return target
  }
  if (target.agentSetup || otherChat(target, thread)) {
    return { ...target, resultsTo: 'chat' }
  }
  const title = options.originChat?.title ?? target.chat?.title
  return {
    ...target,
    runsIn: 'chat',
    chat: {
      sessionId: thread.sessionId,
      ...(title ? { title } : {}),
      homeIfGone: true,
      toConversation: true
    },
    resultsTo: 'chat'
  }
}

/** Which of its flags the caller gave: only those can have been overridden. */
export type GivenFlags = { runsIn: boolean; resultsTo: boolean }

/** The create or edit output's note when the thread changed a choice the caller gave; null otherwise. */
export function originThreadNote(
  asked: AutomationBotTarget,
  saved: AutomationBotTarget | undefined,
  given: GivenFlags
): string | null {
  const thread = saved?.originThread
  if (!thread) {
    return null
  }
  const where = originThreadText(thread)
  const inThread = saved.runsIn === 'chat' && saved.chat?.toConversation === true
  if (!inThread) {
    // It can't answer there; say so when results asked for the thread or its channel.
    const askedThread =
      given.resultsTo &&
      (asked.resultsTo === 'thread' ||
        (typeof asked.resultsTo === 'object' && saved.resultsTo === 'chat'))
    return askedThread
      ? `Made while answering ${where}, but it ${saved.agentSetup ? 'runs on its own agent' : 'runs in another chat'}, so its results stay in Orca instead of posting beside that thread. To answer there, leave out ${saved.agentSetup ? '--agent' : '--runs-in'}.`
      : null
  }
  const runsInChanged =
    asked.runsIn !== saved.runsIn || asked.chat?.sessionId !== saved.chat?.sessionId
  const namedChannel = typeof asked.resultsTo === 'object'
  const flags = [
    ...(given.runsIn && runsInChanged ? ['--runs-in'] : []),
    ...(given.resultsTo && (namedChannel || (asked.resultsTo === 'chat' && runsInChanged))
      ? ['--results-to']
      : [])
  ]
  if (flags.length === 0) {
    return null
  }
  const why =
    given.resultsTo && namedChannel ? " (--results-to named this thread's own channel)" : ''
  return `Made while answering ${where}, so it runs in this chat and replies there: this overrode ${flags.join(' and ')}${why}. To post in a different channel instead, name that channel with --results-to channel:<channel>.`
}
