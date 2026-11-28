import type { PairedServerAskCard } from '../../../../../../src/shared/rpc-contract/paired-server-asks-params'
import type { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import type { MobileNativeChatCollapsedPrompt } from './MobileNativeChatPromptStrip'
import {
  pairedServerAskerName,
  type MobilePairedServerAsks,
  type MobilePairedServerDecision
} from './use-mobile-paired-server-asks'

const DECISIONS: readonly MobilePairedServerDecision[] = ['once', 'always', 'deny']

/** An agent on a paired server asking this chat's agent, on the chat's approval card: title, the
 *  message under it, and Allow once / Always allow <server> / Deny; folding gives the input back. */
export function pairedServerAskSlot(
  asks: MobilePairedServerAsks,
  card: PairedServerAskCard,
  folded: string | null,
  setFolded: (key: string | null) => void,
  t: ReturnType<typeof useMobileTranslation>,
  notice?: string | null
): { card: React.JSX.Element | null; strip: MobileNativeChatCollapsedPrompt | null } {
  // This computer's own name for the server: what it reports about itself could name another.
  const server = card.serverName || t('chat.pairedServerAsk.thisServer', 'this server')
  const title = t(
    'chat.pairedServerAsk.title',
    '{{from}} wants to message {{to}} on this computer',
    {
      from: pairedServerAskerName(card),
      to: card.botName ?? card.botId
    }
  )
  if (folded === card.messageId) {
    return { card: null, strip: { title, expand: () => setFolded(null) } }
  }
  // The server's words as plain text: never Markdown, so none reads as this card's own.
  const message = [card.subject, card.body].filter(Boolean).join('\n\n')
  return {
    strip: null,
    card: (
      <MobileNativeChatPermission
        key={card.messageId}
        permission={{
          title,
          ...(message ? { description: message } : {}),
          options: [
            { label: t('chat.pairedServerAsk.once', 'Allow once'), send: 'once' },
            {
              label: t('chat.pairedServerAsk.always', 'Always allow {{server}}', { server }),
              send: 'always'
            },
            { label: t('chat.pairedServerAsk.deny', 'Deny'), send: 'deny', declines: true }
          ]
        }}
        notice={notice}
        onRespond={async (send) => {
          const decision = DECISIONS.find((option) => option === send)
          return decision ? asks.answer(card, decision) : false
        }}
        onCollapse={() => setFolded(card.messageId)}
      />
    )
  }
}
