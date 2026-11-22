import type { PairedServerAskCard } from '../../../../../../src/shared/rpc-contract/paired-server-asks-params'
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
  return card.from.sender?.bot?.name ?? card.from.sender?.name ?? card.from.label
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
  const server = card.from.sender?.computer ?? card.from.label
  const title = t(
    'chat.pairedServerAsk.title',
    '{{from}} wants to message {{to}} on this computer',
    {
      from: askerName(card),
      to: card.botName ?? card.botId
    }
  )
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
              question: message ? `${title}\n\n> ${message.replace(/\n/g, '\n> ')}` : title,
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
        onAnswer={async ([selection]) => {
          const decision = DECISIONS[selection?.indices[0] ?? -1]
          return decision ? asks.answer(card, decision) : false
        }}
        onCollapse={() => setFolded(card.messageId)}
      />
    )
  }
}
