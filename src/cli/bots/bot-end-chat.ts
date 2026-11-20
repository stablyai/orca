// `orca bot end-chat`: ends one of a bot's side chats when it has nothing left to do; prints why not
// otherwise. An ended chat stays in Session History, and reopening it there brings it back.
import { randomUUID } from 'node:crypto'
import type {
  BotChatEndReason,
  BotChatEndRefusal,
  BotChatEndResult
} from '../../shared/bots/bot-chat-end'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from '../automations/automation-caller-chat'
import { findBot } from './bot'

const SOURCES: Record<string, string> = {
  slack: 'Slack',
  linear: 'Linear',
  github: 'GitHub',
  discord: 'Discord'
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function botChatEndReasonLine(reason: BotChatEndReason): string {
  switch (reason.kind) {
    case 'replying':
      return 'a reply in progress'
    case 'unread':
      return plural(reason.count, 'unread message', 'unread messages')
    case 'requests':
      return plural(reason.count, 'request waiting for an answer', 'requests waiting for an answer')
    case 'questions':
      return plural(reason.count, 'question waiting for a reply', 'questions waiting for a reply')
    case 'ran-workers':
      return 'it ran workers'
    case 'automation':
      return `automation "${reason.name}" posts here`
    case 'automation-run':
      return 'automation run still going'
    case 'usage-continue':
      return 'auto-continue after usage limit'
    case 'restart-offer':
      return 'waiting to continue after a restart'
    case 'stopping':
      return 'its agent is still stopping'
    case 'reopened':
      return 'it was reopened while ending'
    case 'unreadable':
      return "its work couldn't be checked"
  }
}

function refusalText(refusal: BotChatEndRefusal, chat: string): string {
  switch (refusal.kind) {
    case 'home':
      return "Can't end the Home Chat. Run orca bot new-chat to start a fresh one."
    case 'self':
      return "Can't end the chat this command runs in."
    case 'other-bot':
      return 'That chat belongs to another bot.'
    case 'outside-turn':
      return "Can't end chats from an outside thread."
    case 'not-owner':
      return "Only the bot's owner can end its chats."
    case 'linked':
      return `This chat is linked to a ${SOURCES[refusal.source] ?? refusal.source} thread, so it can't be ended.`
    case 'not-found':
      return `No side chat with id ${chat}.`
  }
}

function keptText(reasons: readonly BotChatEndReason[]): string {
  if (reasons.some((reason) => reason.kind === 'ran-workers')) {
    return "Can't end a chat that ran workers."
  }
  if (reasons.length === 1 && reasons[0]?.kind === 'reopened') {
    return "Didn't end this chat: it was reopened while ending."
  }
  return `Can't end this chat yet: ${reasons.map(botChatEndReasonLine).join('; ')}.`
}

/** What the command prints; null when it succeeded (ended, or already ended). */
export function botChatEndFailure(result: BotChatEndResult, chat: string): string | null {
  switch (result.outcome) {
    case 'ended':
    case 'already-ended':
      return null
    case 'kept':
      return keptText(result.reasons)
    case 'refused':
      return refusalText(result.refusal, chat)
    case 'superseded':
      return "Didn't end this chat: it was reopened while ending."
    case 'unknown':
      return "Couldn't confirm the chat ended. Run this again to check."
  }
}

export const BOT_END_CHAT_HANDLER: CommandHandler = async ({ flags, client, json }) => {
  const chat = getOptionalStringFlag(flags, 'chat')
  if (!chat) {
    throw new RuntimeClientError('invalid_argument', 'Missing --chat <id> (from orca bot chats)')
  }
  const selector = getOptionalStringFlag(flags, 'bot')
  const botId = selector ? (await findBot(client, selector)).id : undefined
  const params = {
    ...callerChat(),
    ...(botId ? { botId } : {}),
    opId: randomUUID(),
    chat,
    intent: 'end' as const
  }
  let answer: Awaited<ReturnType<typeof client.call<BotChatEndResult>>>
  try {
    answer = await client.call<BotChatEndResult>('bots.endChat', params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError('unsupported', "This Orca version can't end chats. Update Orca.")
    }
    throw error
  }
  const failure = botChatEndFailure(answer.result, chat)
  if (failure) {
    throw new RuntimeClientError('chat_not_ended', failure, answer.result)
  }
  printResult(answer, json, () =>
    answer.result.outcome === 'ended'
      ? `Ended chat ${answer.result.title ? `"${answer.result.title}"` : chat}.`
      : 'Chat already ended.'
  )
}
