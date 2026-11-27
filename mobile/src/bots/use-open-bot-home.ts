import { useCallback } from 'react'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import { useRpcClientContext } from '../transport/connection/client-context'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { scopeRpcClientToExecutionHost } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { botHomeWorktreeId, ensureBotHomeChat, type HostBot } from './host-bots-read'

/** Where a bot runs: the paired computer that reaches it, and the server it relays, if any. */
export type BotHomePlace = { pairedHostId: string; executionHost: ExecutionHostId }

/** The route to a computer: its paired host's client, scoped to the server it relays. */
export function botPlaceClient(paired: RpcClient, place: BotHomePlace): RpcClient {
  return place.executionHost === LOCAL_EXECUTION_HOST_ID
    ? paired
    : scopeRpcClientToExecutionHost(paired, place.executionHost)
}

/** Opens a bot's Home on its paired computer's screen; the host starts its Home Chat first, which
 *  never fails the open. `homeDraft` lands in that chat's composer. `current` false by the time the
 *  host answers drops the open. `standalone` opens it in place of that computer's list, for Home,
 *  whose bot lists span computers. */
export function useOpenBotHome({ standalone = false } = {}): (
  place: BotHomePlace,
  bot: HostBot,
  options?: { homeDraft?: string; current?: () => boolean }
) => void {
  const openMobileSession = useOpenMobileSession()
  const clients = useRpcClientContext()
  return useCallback(
    (
      place: BotHomePlace,
      bot: HostBot,
      { homeDraft, current }: { homeDraft?: string; current?: () => boolean } = {}
    ) => {
      const openHome = () =>
        openMobileSession({
          hostId: place.pairedHostId,
          worktreeId: botHomeWorktreeId(bot),
          name: bot.name,
          standalone,
          ...(homeDraft ? { homeDraft } : {}),
          ...(place.executionHost === LOCAL_EXECUTION_HOST_ID
            ? {}
            : { executionHost: place.executionHost })
        })
      const client = clients
        .getAllClients()
        .find((entry) => entry.hostId === place.pairedHostId)?.client
      if (!client) {
        openHome()
        return
      }
      void ensureBotHomeChat(botPlaceClient(client, place), bot.id).then(() => {
        if (current?.() !== false) {
          openHome()
        }
      })
    },
    [clients, openMobileSession, standalone]
  )
}
