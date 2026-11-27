// An offer card's answer, kept on its bot as on the desktop: Not now (which tells the bot Dismiss) or
// the card's own action, claimed on the host first so a second device or press sends nothing.
import { useContext, useRef, useState } from 'react'
import {
  BOTS_CONFIRMED_OFFER_ANSWER_RUNTIME_CAPABILITY,
  BOTS_OFFER_ANSWER_RUNTIME_CAPABILITY
} from '../../../../../../src/shared/bot-runtime-capabilities'
import {
  answerBotOffer,
  BOT_OFFER_DISMISS_ANSWER,
  confirmBotOfferAnswer,
  type BotOfferSelection
} from '../../../../../../src/shared/bots/bot-offer-answers'
import { errorMessage } from '../../../../../../src/shared/errors/error-message'
import { botUpdate } from '../../../../bots/bot-sheet-operations'
import {
  publishHostBot,
  publishHostBotOfferAnswer,
  useHostBotById
} from '../../../../bots/host-bot-store'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { isRpcDeliveryUnknown } from '../../../../transport/rpc/rpc-delivery-ambiguity'
import { useRouteCapability } from '../../../../worktree/execution-hosts/use-route-capability'
import {
  MobileBotCardSendContext,
  mobileBotOfferTell,
  useMobileBotCardHost
} from './mobile-bot-card-host'
import { botOfferAnswerSend } from './mobile-bot-card-operations'

export type MobileBotOfferAnswer = {
  /** The bot is read, so its answers are known; until then the card's actions wait. */
  ready: boolean
  dismissed: boolean
  /** What the card's action was taken on, once it was: workspace ids, or import item indices. */
  sent: readonly string[] | null
  error: string | null
  clearError: () => void
  dismiss: () => void
  /** Tells the bot `text` as a card answer (typed on an older host), and keeps `chosen` as this card's answer. */
  send: (text: string, chosen: readonly string[]) => void
}

export function useMobileBotOfferAnswer(botId: string, cardId: string): MobileBotOfferAnswer {
  const t = useMobileTranslation()
  const host = useMobileBotCardHost()
  const card = useContext(MobileBotCardSendContext)
  const takesCardAnswers = useRouteCapability(BOTS_OFFER_ANSWER_RUNTIME_CAPABILITY)
  const hostConfirms = useRouteCapability(BOTS_CONFIRMED_OFFER_ANSWER_RUNTIME_CAPABILITY)
  const bot = useHostBotById(botId)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const running = useRef(false)
  const answer = bot?.offerAnswers?.find((entry) => entry.cardId === cardId)
  const answerOffer = async (selection: BotOfferSelection, text: string): Promise<void> => {
    const client = host?.client
    if (!client || !host || !bot || running.current) {
      return
    }
    running.current = true
    setPending(true)
    setError(null)
    const cardAnswer = takesCardAnswers
      ? async (line: string, sessionId: string) =>
          botOfferAnswerSend.interpret(
            await botOfferAnswerSend.request(client, { botId, sessionId, text: line })
          ).sent
      : null
    const sessionId = card?.sessionId
    const confirm = async (sessionId: string) => {
      const told = await confirmBotOfferAnswer(async () =>
        botOfferAnswerSend.interpret(
          await botOfferAnswerSend.request(client, { botId, sessionId, text, answer: selection })
        )
      )
      if (told.answer) {
        publishHostBotOfferAnswer(host.hostKey, botId, told.answer)
      }
      return told.sent ? 'sent' : 'refused'
    }
    try {
      const outcome =
        hostConfirms && sessionId
          ? await confirm(sessionId)
          : await answerBotOffer(selection, {
              update: async (offerAnswer) =>
                publishHostBot(
                  host.hostKey,
                  botUpdate.interpret(
                    await botUpdate.request(client, { botId, updates: { offerAnswer } })
                  ).bot
                ),
              send: () => mobileBotOfferTell(card, cardAnswer, text),
              deliveryUnknown: isRpcDeliveryUnknown
            })
      if (outcome === 'refused') {
        setError(t('chat.botCards.offer.notSent', "Couldn't send that to the bot. Try again."))
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      running.current = false
      setPending(false)
    }
  }
  return {
    ready: bot !== null && host?.client != null && !pending,
    dismissed: answer?.dismissed === true,
    sent: answer?.sent?.chosen ?? null,
    error,
    clearError: () => setError(null),
    dismiss: () =>
      void answerOffer(
        { cardId, dismissed: true },
        // The card answer keeps the words the bot was promised; typed stays as before.
        takesCardAnswers && card?.sessionId
          ? BOT_OFFER_DISMISS_ANSWER
          : t('chat.botCards.offer.dismiss', 'Dismiss')
      ),
    send: (text, chosen) => void answerOffer({ cardId, sent: { chosen: [...chosen] } }, text)
  }
}
