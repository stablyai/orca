// `orca bot chats` as text: each chat's id first (all `--chat` takes), then its title, when it was
// last active, and its last exchange, as `orca worktree ps` shows an agent's.
import { BOT_CHAT_ID_PREFIX, type BotChatRow } from '../../shared/bots/bot-chat-row'
import { botAddressArgument } from '../../shared/bot-roster'
import { ago, oneLine } from '../workspaces/worktree-ps-format'

export type BotChatsResult = { bot: string; chats: BotChatRow[] }

function formatChat(chat: BotChatRow, address: string, now: number): string {
  const active = ago(chat.lastActivityAt, now)
  const title = oneLine(chat.title)
  const name = chat.closed
    ? `${chat.reason === 'ended' ? `closed (takes no mail; orca bot reopen --chat ${chat.id})` : 'closed (takes no mail)'}${title ? `  ${JSON.stringify(title)}` : ''}`
    : chat.home
      ? 'Home Chat (current)'
      : title
        ? JSON.stringify(title)
        : '(untitled)'
  const asked = oneLine(chat.lastAsked)
  const said = oneLine(chat.lastSaid)
  return [
    [
      `${BOT_CHAT_ID_PREFIX}${chat.id}`,
      name,
      ...(active ? [`active ${active}`] : []),
      ...(chat.self ? ['(this chat)'] : []),
      ...(chat.home && !chat.closed ? [`<- where --to ${address} lands`] : [])
    ].join('  '),
    ...(asked ? [`  last asked: ${asked}`] : []),
    ...(said ? [`  last said:  ${said}`] : [])
  ].join('\n')
}

export function formatBotChats(result: BotChatsResult, now = Date.now()): string {
  if (result.chats.length === 0) {
    return `${result.bot} has no chat that takes mail.`
  }
  const address = botAddressArgument(result.bot)
  return [
    ...result.chats.map((chat) => formatChat(chat, address, now)),
    [
      "Titles only help match your owner's words; if more than one chat fits, ask them which.",
      `Ask one: orca orchestration send --to ${address} --chat <id> --type question|handoff --subject "<text>"`
    ].join('\n')
  ].join('\n\n')
}
