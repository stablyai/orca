import {
  NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER,
  NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE,
  NATIVE_CHAT_WEBHOOK_DIRECTIVE_MARKER,
  parseNativeChatVisualDirectiveLine,
  withLegacyNativeChatIdeasAsList,
  type NativeChatVisualDirective
} from '../../../../../src/shared/native-chat/visuals/native-chat-visual-directive'
import {
  nativeChatBotDirectiveCardOf,
  type NativeChatDirectiveBotCard
} from '../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { mobileMarkdownCodeLines } from '../parsing/mobile-markdown-tree'
// Private-use delimiters, as the preview normalizer's own code placeholders use.
const PLACEHOLDER_PREFIX = '\uE000ORCA_VISUAL_'
const PLACEHOLDER = /^\uE000ORCA_VISUAL_(\d+)\uE000$/
const CARD_PREFIX = '\uE000ORCA_CARD_'
const CARD_PLACEHOLDER = /^\uE000ORCA_CARD_(\d+)\uE000$/

export type MobileMarkdownVisualLines = {
  /** The content with each recognized directive line replaced by a placeholder line. */
  text: string
  directives: NativeChatVisualDirective[]
  /** The bot cards its lines name (a webhook card), each its own placeholder block. */
  cards: NativeChatDirectiveBotCard[]
}

function placeholderFor(index: number): string {
  return `${PLACEHOLDER_PREFIX}${index}\uE000`
}

// Extract assistant visual directives before parser decodes entities/tags and rewrites titles; only non-code top-level marker lines count. Past cap, keep literal text.
export function protectMobileMarkdownVisualLines(raw: string): MobileMarkdownVisualLines {
  const content = withLegacyNativeChatIdeasAsList(raw)
  // Text that already spells a placeholder would alias a real one; it renders no visuals at all.
  if (
    content.includes(PLACEHOLDER_PREFIX) ||
    content.includes(CARD_PREFIX) ||
    ![NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER, NATIVE_CHAT_WEBHOOK_DIRECTIVE_MARKER].some((marker) =>
      content.includes(marker)
    )
  ) {
    return { text: content, directives: [], cards: [] }
  }
  const normalized = content.replace(/\r\n?/g, '\n')
  const code = mobileMarkdownCodeLines(normalized)
  const directives: NativeChatVisualDirective[] = []
  const cards: NativeChatDirectiveBotCard[] = []
  const next = normalized.split('\n').map((line, index) => {
    if (code.has(index)) {
      return line
    }
    const card = nativeChatBotDirectiveCardOf(line)
    if (card) {
      if (cards.length >= NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE) {
        return line
      }
      cards.push(card)
      return `\n${CARD_PREFIX}${cards.length - 1}\uE000\n`
    }
    if (directives.length >= NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE) {
      return line
    }
    const directive = parseNativeChatVisualDirectiveLine(line)
    if (!directive) {
      return line
    }
    directives.push(directive)
    // Blank lines around it make the directive its own block, splitting any paragraph it was in.
    return `\n${placeholderFor(directives.length - 1)}\n`
  })
  return { text: next.join('\n'), directives, cards }
}

/** The directive index a parsed line stands for, or null for any other line. */
export function mobileMarkdownVisualPlaceholderIndex(line: string, count: number): number | null {
  const match = PLACEHOLDER.exec(line.trim())
  if (!match) {
    return null
  }
  const index = Number(match[1])
  return index < count ? index : null
}

/** The card index a parsed line stands for, or null for any other line. */
export function mobileMarkdownCardPlaceholderIndex(line: string, count: number): number | null {
  const match = CARD_PLACEHOLDER.exec(line.trim())
  if (!match) {
    return null
  }
  const index = Number(match[1])
  return index < count ? index : null
}
