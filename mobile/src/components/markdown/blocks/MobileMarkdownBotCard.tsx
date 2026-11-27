import { useContext } from 'react'
import type { NativeChatDirectiveBotCard } from '../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { webhookCardFallbackText } from '../../../../../src/shared/webhook-card-fallback'
import { MarkdownText } from '../mobile-markdown-text'
import { MobileMarkdownBotCardContext } from './mobile-markdown-bot-card-context'
import type { ParagraphText } from './mobile-markdown-blocks'

function fallbackText(card: NativeChatDirectiveBotCard): string {
  switch (card.kind) {
    case 'webhook':
      return webhookCardFallbackText(null)
  }
}

/** A bot card a reply line names: the chat draws it; anywhere else, its line in words. */
export function MobileMarkdownBotCard({
  card,
  text
}: {
  card: NativeChatDirectiveBotCard
  text: ParagraphText
}): React.JSX.Element {
  const draw = useContext(MobileMarkdownBotCardContext)
  if (draw) {
    return <>{draw(card)}</>
  }
  return (
    <MarkdownText selectable={text.selectable} style={text.style}>
      {fallbackText(card)}
    </MarkdownText>
  )
}
