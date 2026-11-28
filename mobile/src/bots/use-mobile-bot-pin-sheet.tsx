import { useCallback, useState, type ReactElement } from 'react'
import { Pin, PinOff } from 'lucide-react-native'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { rpcClientForExecutionHost } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { botPinOffered } from './bot-pin-offered'
import { botUpdate } from './bot-sheet-operations'
import type { MobileBotRowFacts } from './host-bot-row-facts'

type PinTarget = {
  id: string
  name: string
  pinned: boolean
  hostId: ExecutionHostId
  hostLabel: string
}

/** Long-press a bot row to pin it on the computer that runs it. */
export function useMobileBotPinSheet(args: {
  client: RpcClient | null
  hostCapabilities: readonly string[]
  onError: (message: string) => void
}): {
  open: (facts: MobileBotRowFacts, name: string, readOnly: boolean) => void
  sheet: ReactElement
} {
  const t = useMobileTranslation()
  const [pinBot, setPinBot] = useState<PinTarget | null>(null)
  const open = useCallback((facts: MobileBotRowFacts, name: string, readOnly: boolean) => {
    // A down computer cannot take the pin; the row already says so. Nor can an older host, whose strict
    // bots.update refuses `pinned`: it offers no long-press pin at all.
    if (!botPinOffered(facts, readOnly)) {
      return
    }
    setPinBot({
      id: facts.botId,
      name,
      pinned: facts.pinned === true,
      hostId: facts.host?.id ?? LOCAL_EXECUTION_HOST_ID,
      hostLabel: facts.host?.label ?? name
    })
  }, [])
  const save = useCallback(() => {
    const target = pinBot
    const paired = args.client
    if (!target || !paired) {
      return
    }
    // A server's bot is updated on that server, never on the paired computer that lists it.
    const rpc = rpcClientForExecutionHost(
      paired,
      args.hostCapabilities,
      target.hostId === LOCAL_EXECUTION_HOST_ID ? undefined : target.hostId
    )
    if (!rpc) {
      args.onError(
        t('bots.list.cantReach', 'Can’t reach {{host}}. Its bots show when it’s back.', {
          host: target.hostLabel
        })
      )
      return
    }
    void botUpdate
      .request(
        rpc,
        { botId: target.id, updates: { pinned: !target.pinned } },
        { failWhenDisconnected: true }
      )
      .then(botUpdate.interpret)
      .catch((error: unknown) => {
        args.onError(error instanceof Error ? error.message : String(error))
      })
  }, [args, pinBot, t])
  const sheet = (
    <ActionSheetModal
      visible={pinBot !== null}
      title={pinBot?.name}
      onClose={() => setPinBot(null)}
      actions={
        pinBot
          ? [
              {
                label: pinBot.pinned
                  ? t('hostScreen.hostScreenOverlays.unpin', 'Unpin')
                  : t('hostScreen.hostScreenOverlays.pin', 'Pin'),
                icon: pinBot.pinned ? PinOff : Pin,
                onPress: save
              }
            ]
          : []
      }
    />
  )
  return { open, sheet }
}
