import { useEffect, useState } from 'react'
import type { BotUpNext } from '../../../src/shared/bots/bot-look-around'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { lookNowRefusalText } from './bot-up-next-copy'
import {
  lookAroundNow,
  suggestionDismiss,
  suggestionStart,
  upNextSeen
} from './bot-up-next-operations'
import type { UpNextActions } from './MobileBotUpNext'

/** Start, Dismiss and Look now through the bot's host; each re-reads the bot's Activity after.
 *  While Up next shows, its new suggestions are marked seen, which clears the desktop's count. */
export function useBotUpNext({
  client,
  botId,
  upNext,
  showing,
  showToast,
  onStart,
  refresh,
  online
}: {
  client: RpcClient | null
  botId: string
  upNext: BotUpNext | undefined
  showing: boolean
  showToast: (message: string, durationMs?: number) => void
  /** Puts the request in the Home Chat's message box, unsent; null while no chat shows. */
  onStart: ((ask: string) => void) | null
  refresh: () => void
  /** The host answers; off, the actions are too. */
  online: boolean
}): UpNextActions & { lookNow: () => void } {
  const t = useMobileTranslation()
  const [busy, setBusy] = useState(false)
  const seenAt = upNext?.state.seenAt ?? 0
  const unseen = upNext?.items.some((item) => item.createdAt > seenAt) ?? false
  useEffect(() => {
    if (!showing || !unseen || !client) {
      return
    }
    void upNextSeen
      .request(client, { botId })
      .then(refresh)
      .catch(() => {})
  }, [showing, unseen, client, botId, refresh])

  const act = async (
    run: (client: RpcClient) => Promise<void>,
    failed: (error: unknown) => void
  ) => {
    if (!client || busy) {
      return
    }
    setBusy(true)
    try {
      await run(client)
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const start = onStart
    ? (suggestionId: string) =>
        void act(
          async (rpc) => {
            const { ask } = suggestionStart.interpret(
              await suggestionStart.request(
                rpc,
                { botId, suggestionId },
                { failWhenDisconnected: true }
              )
            )
            onStart(ask)
          },
          () =>
            showToast(t('bots.upNext.startFailed', 'That suggestion is no longer listed.'), 1800)
        )
    : null

  const dismiss = (suggestionId: string) =>
    void act(
      async (rpc) => {
        suggestionDismiss.interpret(
          await suggestionDismiss.request(
            rpc,
            { botId, suggestionId },
            { failWhenDisconnected: true }
          )
        )
      },
      () => showToast(t('bots.saveFailed', 'Couldn’t save'), 1800)
    )

  const lookNow = () =>
    void act(
      async (rpc) => {
        lookAroundNow.interpret(
          await lookAroundNow.request(rpc, { botId }, { failWhenDisconnected: true })
        )
      },
      (error) => showToast(lookNowRefusalText(error instanceof Error ? error.message : ''), 1800)
    )

  return { start, dismiss, lookNow, busy: busy || !online }
}
