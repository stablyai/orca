// A bot's Tidy-up on its host, re-read with the route (botsChanged, reconnect, foreground) so a
// run that ends, or one started on the desktop, shows without reopening Settings.
import { useCallback, useEffect, useState } from 'react'
import type { BotTidyUpView } from '../../../src/shared/bots/bot-tidy-up'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { tidyUpGet, tidyUpNow, tidyUpUndo } from './bot-tidy-up-operations'

/** The host's Tidy-up for this bot, with Tidy now and Undo. */
export function useMobileBotTidyUp(
  client: RpcClient | null,
  botId: string,
  /** The route's read count (botsChanged, reconnect, foreground): a run that ends re-reads with it. */
  routeReads: number,
  showToast: (message: string, durationMs?: number) => void
) {
  const t = useMobileTranslation()
  const [view, setView] = useState<BotTidyUpView | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    if (!client) {
      return
    }
    try {
      setView(tidyUpGet.interpret(await tidyUpGet.request(client, { botId })).tidyUp)
    } catch {
      // A host that predates Tidy-up has none to show.
      setView(null)
    }
  }, [client, botId])
  useEffect(() => {
    void load()
  }, [load, routeReads])
  const act = async (run: (rpc: RpcClient) => Promise<void>, failed: (error: unknown) => void) => {
    if (!client) {
      return
    }
    setBusy(true)
    try {
      await run(client)
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
      void load()
    }
  }
  const tidyNow = () =>
    void act(
      async (rpc) => {
        tidyUpNow.interpret(await tidyUpNow.request(rpc, { botId }))
      },
      (error) => {
        const code = error instanceof Error ? error.message : ''
        showToast(
          code.includes('tidy_now_running')
            ? t('bots.tidyUp.nowRunning', 'Already tidying.')
            : code.includes('tidy_now_busy')
              ? t('bots.tidyUp.nowBusy', 'A chat is still working. Try again when it’s done.')
              : t('bots.tidyUp.nowFailed', 'Could not start a tidy-up. Try again.'),
          1800
        )
      }
    )
  const undo = (rowId: string) =>
    void act(
      async (rpc) => {
        const reply = tidyUpUndo.interpret(await tidyUpUndo.request(rpc, { botId, rowId }))
        if (!reply.undone) {
          showToast(
            t(
              'bots.tidyUp.undoSuperseded',
              'Memory changed since this tidy-up, so it was left as it is.'
            ),
            1800
          )
        }
      },
      (error) =>
        showToast(
          error instanceof Error && error.message.includes('tidy_up_stale')
            ? t('bots.tidyUp.undoStale', 'A newer tidy-up ran since. Review it before undoing.')
            : t('bots.tidyUp.undoFailed', 'Could not undo the tidy-up.'),
          1800
        )
    )
  return { view, busy, tidyNow, undo }
}
