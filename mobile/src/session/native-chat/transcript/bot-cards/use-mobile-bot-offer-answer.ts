// An offer card's answer, kept on its bot as on the desktop: Not now (which tells the bot Dismiss) or
// the card's own action, claimed on the host first so a second device or press sends nothing.
import { useContext, useState } from 'react'
import {
  answerBotOffer,
  type BotOfferAnswer
} from '../../../../../../src/shared/bots/bot-offer-answers'
import { errorMessage } from '../../../../../../src/shared/errors/error-message'
import { botUpdate } from '../../../../bots/bot-sheet-operations'
import { publishHostBot, useHostBotById } from '../../../../bots/host-bot-store'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileBotCardSendContext, useMobileBotCardHost } from './mobile-bot-card-host'

export type MobileBotOfferAnswer = {
  /** The bot is read, so its answers are known; until then the card's actions wait. */
  ready: boolean
  dismissed: boolean
  /** What the card's action was taken on, once it was: workspace ids, or import item indices. */
  sent: readonly string[] | null
  error: string | null
  clearError: () => void
  dismiss: () => void
  /** Tells the bot `text`, as if typed, and keeps `chosen` as this card's answer. */
  send: (text: string, chosen: readonly string[]) => void
}

export function useMobileBotOfferAnswer(botId: string, cardId: string): MobileBotOfferAnswer {
  const t = useMobileTranslation()
  const host = useMobileBotCardHost()
  const send = useContext(MobileBotCardSendContext)
  const bot = useHostBotById(botId)
  const [error, setError] = useState<string | null>(null)
  const answer = bot?.offerAnswers?.find((entry) => entry.cardId === cardId)
  const answerOffer = (
    update: BotOfferAnswer & ({ dismissed: true } | { sent: { chosen: string[] } }),
    text: string
  ): void => {
    const client = host?.client
    if (!client || !host || !bot) {
      return
    }
    setError(null)
    void answerBotOffer(update, {
      update: async (offerAnswer) =>
        publishHostBot(
          host.hostKey,
          botUpdate.interpret(await botUpdate.request(client, { botId, updates: { offerAnswer } }))
            .bot
        ),
      send: async () => (await send?.(text)) === true
    })
      .then((outcome) => {
        if (outcome === 'refused') {
          setError(t('chat.botCards.offer.notSent', "Couldn't send that to the bot. Try again."))
        }
      })
      .catch((caught: unknown) => setError(errorMessage(caught)))
  }
  return {
    ready: bot !== null && host?.client != null,
    dismissed: answer?.dismissed === true,
    sent: answer?.sent?.chosen ?? null,
    error,
    clearError: () => setError(null),
    dismiss: () =>
      answerOffer({ cardId, dismissed: true }, t('chat.botCards.offer.dismiss', 'Dismiss')),
    send: (text, chosen) => answerOffer({ cardId, sent: { chosen: [...chosen] } }, text)
  }
}
