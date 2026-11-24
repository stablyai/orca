import { useLayoutEffect, useRef } from 'react'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { GenerationStore } from '../generations/generation-store'
import { fetchDeferredAssetsFromDesktop } from '../generations/generation-deferred-assets'
import { deriveHostCacheKey } from '../generations/host-cache-key'
import { deferredCodeParamsSchema } from '../bridge/native-capabilities/bridge-native-verbs'

export function useDeferredCodeServer(
  hostId: string,
  buildId: string | null,
  store: GenerationStore
): (params: unknown) => Promise<Record<string, never>> {
  const { client } = useHostClient(hostId)
  const clientRef = useRef(client)
  useLayoutEffect(() => {
    clientRef.current = client
  }, [client])
  return async (params) => {
    deferredCodeParamsSchema.parse(params)
    if (buildId === null) {
      throw new Error('no page is showing to fetch deferred code for')
    }
    await store.fillDeferredAssets(deriveHostCacheKey(hostId), buildId, async (missing) => {
      // A fetch cut by a dropped or replaced connection tries again once the desktop is back, so a
      // diagram waits for its engine instead of settling for its source.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await fetchDeferredAssetsFromDesktop(await connected(clientRef.current), missing)
        } catch (error) {
          if (attempt === MAX_FETCH_ATTEMPTS) {
            throw error
          }
        }
      }
    })
    return {}
  }
}

const MAX_FETCH_ATTEMPTS = 3

function connected(client: RpcClient | null): Promise<RpcClient> {
  if (client === null) {
    return Promise.reject(new Error('no desktop connection to fetch deferred code from'))
  }
  return new Promise((resolve) => {
    if (client.getState() === 'connected') {
      resolve(client)
      return
    }
    const stop = client.onStateChange((state) => {
      if (state === 'connected') {
        stop()
        resolve(client)
      }
    })
  })
}
