import { Text } from 'react-native'
import type { PairedServerAskCard } from '../../../../../../src/shared/rpc-contract/paired-server-asks-params'
import { toSafeDisplayLine } from '../../../../../../src/shared/text/display-text-safety'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import type { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import type { MobileNativeChatCollapsedPrompt } from './MobileNativeChatPromptStrip'
import type {
  MobilePairedServerAsks,
  MobilePairedServerDecision
} from './use-mobile-paired-server-asks'

const NO_OTHER = [false] as const
const DECISIONS: readonly MobilePairedServerDecision[] = ['once', 'always', 'deny']

/** Who on the paired server asks: its agent's bot name, else its own name, else how it signs. */
function askerName(card: PairedServerAskCard): string {
  return toSafeDisplayLine(card.from.sender?.bot?.name ?? card.from.sender?.name ?? card.from.label)
}

/** Text the server wrote, shown as itself inside the card's Markdown title. */
function literal(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&')
}

/** An agent on a paired server asking this chat's agent, in the chat's own question card: title,
 *  the message under it, and Allow once / Always allow <server> / Deny; folding gives the input back. */
export function pairedServerAskSlot(
  asks: MobilePairedServerAsks,
  card: PairedServerAskCard,
  folded: string | null,
  setFolded: (key: string | null) => void,
  t: ReturnType<typeof useMobileTranslation>
): { card: React.JSX.Element | null; strip: MobileNativeChatCollapsedPrompt | null } {
  // This computer's own name for the server: what it reports about itself could name another.
  const server = card.serverName || t('chat.pairedServerAsk.thisServer', 'this server')
  const titleOf = (name: (text: string) => string): string =>
    t('chat.pairedServerAsk.title', '{{from}} wants to message {{to}} on this computer', {
      from: name(askerName(card)),
      to: name(card.botName ?? card.botId)
    })
  // The strip shows text as it is; the card's title is Markdown.
  const title = titleOf((text) => text)
  if (folded === card.messageId) {
    return { card: null, strip: { title, expand: () => setFolded(null) } }
  }
  const message = [card.subject, card.body].filter(Boolean).join('\n\n')
  return {
    strip: null,
    card: (
      <MobileNativeChatAsk
        key={card.messageId}
        prompt={{
          questions: [
            {
              question: titleOf(literal),
              multiSelect: false,
              options: [
                { label: t('chat.pairedServerAsk.once', 'Allow once') },
                { label: t('chat.pairedServerAsk.always', 'Always allow {{server}}', { server }) },
                { label: t('chat.pairedServerAsk.deny', 'Deny') }
              ]
            }
          ]
        }}
        allowOther={NO_OTHER}
        choiceOnly
        // The server's words as plain text: never Markdown, so none reads as this card's own.
        note={message ? <Text style={styles.message}>{message}</Text> : undefined}
        onAnswer={async ([selection]) => {
          const decision = DECISIONS[selection?.indices[0] ?? -1]
          return decision ? asks.answer(card, decision) : false
        }}
        onCollapse={() => setFolded(card.messageId)}
      />
    )
  }
}

const styles = themedStyleSheet(() => ({
  message: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
    fontSize: typography.bodySize,
    color: colors.textSecondary
  }
}))
