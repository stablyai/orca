import { createContext } from 'react'
import {
  BOT_CHAT_MENTION_PREFIX,
  botMentionLabel
} from '../../../../../src/shared/bots/bot-mention-context'
import { BOT_ADDRESS_PREFIX } from '../../../../../src/shared/bot-roster'
import {
  SLACK_MENTION_HREF,
  type SlackPeople
} from '../../../../../src/shared/connectors/slack-message-markup'

/** The Slack people the chat knows; with them, Slack's `<@U…>` tokens in its text draw as names. */
export const MobileMarkdownSlackPeopleContext = createContext<SlackPeople | null>(null)

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] }

function plainText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(plainText).join('') ?? ''
}

/** A Slack message's drawn form writes each mention as a link to the marker: drawn as a mention. */
export function drawMobileMarkdownSlackMentions(node: MarkdownNode): void {
  if (!node.children) {
    return
  }
  node.children = node.children.map((child) => {
    if (child.type === 'link' && child.url === SLACK_MENTION_HREF) {
      return { type: 'mention', value: plainText(child) }
    }
    drawMobileMarkdownSlackMentions(child)
    return child
  })
}

const BOT_TOKEN_TEXT = 'Bot: '

/** A picked bot's `[Bot: <name>](bot:<id>)`, or one of its chats', drawn as the desktop's `@` chip. */
export function drawMobileMarkdownBotMentions(node: MarkdownNode): void {
  if (!node.children) {
    return
  }
  node.children = node.children.map((child) => {
    const text = child.type === 'link' ? plainText(child) : ''
    const url = child.url ?? ''
    if (
      text.startsWith(BOT_TOKEN_TEXT) &&
      (url.startsWith(BOT_ADDRESS_PREFIX) || url.startsWith(BOT_CHAT_MENTION_PREFIX))
    ) {
      const name = text.slice(BOT_TOKEN_TEXT.length)
      const chatId = url.startsWith(BOT_CHAT_MENTION_PREFIX) ? url.split('/')[1] : undefined
      return { type: 'mention', value: botMentionLabel({ name, chatId }) }
    }
    drawMobileMarkdownBotMentions(child)
    return child
  })
}
