// The phone's renderer for every bot card kind. The map's type comes from the shared card table, so a
// kind without a renderer here fails the typecheck.
import {
  nativeChatBotCardsOf,
  type NativeChatBlockBotCard,
  type NativeChatBotCardValues,
  type NativeChatDirectiveBotCard,
  type NativeChatMessageBotCard,
  type NativeChatPhoneBotCardRenderers
} from '../../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import type { NativeChatBotCardFields } from '../../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-fields'
import {
  isConnectorCardOffer,
  MobileNativeChatConnectorOfferRow
} from '../MobileNativeChatConnectorOfferRow'
import { MobileBotBackupSwitchCard } from './MobileBotBackupSwitchCard'
import { MobileBotCreateOfferCard } from './MobileBotCreateOfferCard'
import { MobileBotImportDoneCard } from './MobileBotImportDoneCard'
import { MobileBotImportPlanCard } from './MobileBotImportPlanCard'
import { MobileBotMemoryUpdatedRow } from './MobileBotMemoryUpdatedRow'
import { MobileBotRequestCard } from './MobileBotRequestCard'
import { MobileBotToolAddedCard } from './MobileBotToolAddedCard'
import { MobileBotWebhookCard } from './MobileBotWebhookCard'
import { MobileComposioSetupCard } from './MobileComposioSetupCard'
import { MobileGoogleSetupCard } from './MobileGoogleSetupCard'

export type MobileBotCardContext = {
  /** The transcript row carrying the card: its fold and its offer answer key. */
  cardId: string
  timestamp: number | null
  /** The host's line, for a card the phone can't draw. */
  fallback: string
  fontScale: number
}

const MOBILE_BOT_CARDS: NativeChatPhoneBotCardRenderers<
  React.JSX.Element | null,
  MobileBotCardContext
> = {
  memoryUpdated: (note, { cardId, fontScale }) => (
    <MobileBotMemoryUpdatedRow note={note} cardId={cardId} fontScale={fontScale} />
  ),
  // A sign-in or webhook offer is the host's line on the phone.
  connectorOffer: (offer, { cardId, fontScale }) =>
    isConnectorCardOffer(offer) ? (
      <MobileNativeChatConnectorOfferRow offer={offer} cardId={cardId} fontScale={fontScale} />
    ) : null,
  importPlan: (plan, { cardId, fontScale }) => (
    <MobileBotImportPlanCard plan={plan} cardId={cardId} fontScale={fontScale} />
  ),
  importDone: (done, { fontScale }) => (
    <MobileBotImportDoneCard done={done} fontScale={fontScale} />
  ),
  botRequest: (card, { cardId, timestamp, fallback, fontScale }) => (
    <MobileBotRequestCard
      card={card}
      cardId={cardId}
      timestamp={timestamp}
      fallback={fallback}
      fontScale={fontScale}
    />
  ),
  googleSetup: (card, { fallback, fontScale }) => (
    <MobileGoogleSetupCard card={card} fallback={fallback} fontScale={fontScale} />
  ),
  composioSetup: (card, { fallback, fontScale }) => (
    <MobileComposioSetupCard card={card} fallback={fallback} fontScale={fontScale} />
  ),
  createOffer: (offer, { cardId, fallback, fontScale }) => (
    <MobileBotCreateOfferCard
      offer={offer}
      cardId={cardId}
      fallback={fallback}
      fontScale={fontScale}
    />
  ),
  toolAdded: (added, { timestamp, fontScale }) => (
    <MobileBotToolAddedCard added={added} timestamp={timestamp} fontScale={fontScale} />
  ),
  botBackupModelSwitch: (switched, { timestamp, fontScale }) => (
    <MobileBotBackupSwitchCard switched={switched} timestamp={timestamp} fontScale={fontScale} />
  ),
  webhook: (directive, { fontScale }) => (
    <MobileBotWebhookCard directive={directive} fontScale={fontScale} />
  )
}

type AnyCard = NativeChatBlockBotCard | NativeChatMessageBotCard | NativeChatDirectiveBotCard

function draw<K extends AnyCard['kind']>(
  card: { kind: K; value: NativeChatBotCardValues[K] },
  context: MobileBotCardContext
): React.JSX.Element | null {
  const render: NativeChatPhoneBotCardRenderers<React.JSX.Element | null, MobileBotCardContext>[K] =
    MOBILE_BOT_CARDS[card.kind]
  return render(card.value, context)
}

/** The first card a status line carries that the phone draws; null to show the host's line. */
export function mobileNativeChatBotCard(
  block: NativeChatBotCardFields,
  context: MobileBotCardContext
): React.JSX.Element | null {
  for (const card of nativeChatBotCardsOf(block)) {
    const drawn = draw(card, context)
    if (drawn !== null) {
      return drawn
    }
  }
  return null
}

/** The card a whole message or a reply line is drawn as. */
export function mobileNativeChatOtherBotCard(
  card: NativeChatMessageBotCard | NativeChatDirectiveBotCard,
  context: MobileBotCardContext
): React.JSX.Element | null {
  return draw(card, context)
}
