import { useHostClient } from '../../transport/connection/host-client-hooks'
import { useRpcClientContext } from '../../transport/connection/client-context'
import type { RpcClientContextValue } from '../../transport/connection/rpc-client-context-contract'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { GenerationStore } from '../generations/generation-store'
import {
  fetchDeferredAssetsFromDesktop,
  type FetchDeferredAssets
} from '../generations/generation-deferred-assets'
import { deriveHostCacheKey } from '../generations/host-cache-key'
import { deferredCodeParamsSchema } from '../bridge/native-capabilities/bridge-native-verbs'

export function useDeferredCodeServer(
  hostId: string,
  buildId: string | null,
  store: Pick<GenerationStore, 'fillDeferredAssets'>
): (params: unknown) => Promise<Record<string, never>> {
  const { clientId } = useHostClient(hostId)
  const connections = useRpcClientContext()
  return async (params) => {
    deferredCodeParamsSchema.parse(params)
    if (buildId === null) {
      throw new Error('no page is showing to fetch deferred code for')
    }
    if (clientId === null) {
      throw new Error('no desktop connection to fetch deferred code from')
    }
    // Pages of one credential share this fill, so it follows the credential's live connection, not
    // the page that started it; a replaced credential ends it.
    const fetch: FetchDeferredAssets = async (missing) => {
      // A fetch cut by a dropped or replaced connection tries again once the desktop is back, so a
      // diagram waits for its engine instead of settling for its source.
      for (let attempt = 1; ; attempt += 1) {
        try {
          const client = await connectedFor(connections, hostId, clientId)
          return await fetchDeferredAssetsFromDesktop(client, missing)
        } catch (error) {
          if (attempt === MAX_FETCH_ATTEMPTS || isReplaced(connections, hostId, clientId)) {
            throw error
          }
        }
      }
    }
    await store.fillDeferredAssets(deriveHostCacheKey(hostId), buildId, fetch, clientId)
    return {}
  }
}

const MAX_FETCH_ATTEMPTS = 3

function isReplaced(connections: RpcClientContextValue, hostId: string, clientId: string): boolean {
  const live = connections.getClientId(hostId)
  return live !== null && live !== clientId
}

// The credential's current client once it is connected; a reopen with the same credential counts.
function connectedFor(
  connections: RpcClientContextValue,
  hostId: string,
  clientId: string
): Promise<RpcClient> {
  return new Promise((resolve, reject) => {
    let settled = false
    let watched: RpcClient | null = null
    let stopClient = (): void => {}
    let stopHost = (): void => {}
    const finish = (): void => {
      settled = true
      stopHost()
      stopClient()
    }
    const check = (): void => {
      if (settled) {
        return
      }
      if (isReplaced(connections, hostId, clientId)) {
        finish()
        reject(new Error('the credential that asked for deferred code was replaced'))
        return
      }
      const client =
        connections.getClientId(hostId) === clientId
          ? (connections.getAllClients().find((entry) => entry.hostId === hostId)?.client ?? null)
          : null
      if (client?.getState() === 'connected') {
        finish()
        resolve(client)
        return
      }
      // Resubscribe only for a different client: re-adding during its own notification would loop.
      if (client !== watched) {
        stopClient()
        watched = client
        stopClient = client ? client.onStateChange(check) : () => {}
      }
    }
    const unsubscribe = connections.subscribeHostState(hostId, check)
    stopHost = unsubscribe
    if (settled) {
      unsubscribe()
    } else {
      check()
    }
  })
}
