import { sendMobileNativeChatPermissionResponse } from '../../session/native-chat/input/prompts/mobile-native-chat-permission-send'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { HostClientAcquisition } from '../../transport/connection/host-client-acquisition-registry'
import type { RpcClientContextValue } from '../../transport/connection/rpc-client-context-contract'
import { loadHosts } from '../../host-catalog/host-store'
import { deliverWatchPromptReply, type WatchPromptOutcome } from './watch-prompt-delivery'
import type { PendingWatchPrompt } from './watch-prompt-action'

const CONNECT_WAIT_MS = 12_000

type WatchPromptContext = Pick<
  RpcClientContextValue,
  'acquire' | 'release' | 'subscribeHostState' | 'getAllClients'
>

/** Opens the paired host if needed and answers the prompt the watch tapped. */
export async function answerWatchPrompt(
  ctx: WatchPromptContext,
  pending: PendingWatchPrompt
): Promise<WatchPromptOutcome> {
  let hosts: Awaited<ReturnType<typeof loadHosts>>
  try {
    hosts = await loadHosts()
  } catch {
    return 'rejected'
  }
  const host = hosts.find((entry) => entry.id === pending.hostId)
  if (!host) {
    return 'stale'
  }
  const acquisition: HostClientAcquisition = {}
  try {
    const immediate = ctx.acquire(pending.hostId, acquisition, host)
    const client = immediate ?? (await waitForClient(ctx, pending.hostId))
    if (!client) {
      return 'rejected'
    }
    return await deliverWatchPromptReply({
      client,
      pending,
      send: (terminal, text) =>
        sendMobileNativeChatPermissionResponse({
          client,
          terminal,
          deviceToken: host.deviceToken,
          text
        }).then((outcome) => (outcome === 'queued' ? 'rejected' : outcome))
    })
  } catch {
    return 'rejected'
  } finally {
    ctx.release(pending.hostId, acquisition)
  }
}

function waitForClient(ctx: WatchPromptContext, hostId: string): Promise<RpcClient | null> {
  const found = clientFor(ctx, hostId)
  if (found) {
    return Promise.resolve(found)
  }
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = (): void => {}
    const finish = (client: RpcClient | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(client)
    }
    const timer = setTimeout(() => finish(clientFor(ctx, hostId)), CONNECT_WAIT_MS)
    unsubscribe = ctx.subscribeHostState(hostId, () => {
      const client = clientFor(ctx, hostId)
      if (client) {
        finish(client)
      }
    })
    // The socket can connect between the first lookup and this subscription.
    const raced = clientFor(ctx, hostId)
    if (raced) {
      finish(raced)
    }
  })
}

function clientFor(ctx: WatchPromptContext, hostId: string): RpcClient | null {
  return ctx.getAllClients().find((entry) => entry.hostId === hostId)?.client ?? null
}
