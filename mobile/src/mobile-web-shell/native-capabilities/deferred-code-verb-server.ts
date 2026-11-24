import { useEffect, useLayoutEffect, useRef } from 'react'
import { useHostClient } from '../../transport/connection/host-client-hooks'
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
  store: GenerationStore
): (params: unknown) => Promise<Record<string, never>> {
  const { client, clientId } = useHostClient(hostId)
  const clientRef = useRef(client)
  useLayoutEffect(() => {
    clientRef.current = client
  }, [client])
  // A document retired by a replaced credential ends its wait, so its shared fill settles and clears.
  const retiredRef = useRef<AbortSignal | null>(null)
  useEffect(() => {
    const retired = new AbortController()
    retiredRef.current = retired.signal
    return () => retired.abort()
  }, [])
  return async (params) => {
    deferredCodeParamsSchema.parse(params)
    if (buildId === null) {
      throw new Error('no page is showing to fetch deferred code for')
    }
    const retired = retiredRef.current
    const fetch: FetchDeferredAssets = async (missing) => {
      // A fetch cut by a dropped or replaced connection tries again once the desktop is back, so a
      // diagram waits for its engine instead of settling for its source.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await fetchDeferredAssetsFromDesktop(
            await connected(clientRef.current, retired),
            missing
          )
        } catch (error) {
          if (attempt === MAX_FETCH_ATTEMPTS || retired?.aborted) {
            throw error
          }
        }
      }
    }
    // Shared per credential: a replacement document never joins a fill bound to a retired client.
    await store.fillDeferredAssets(deriveHostCacheKey(hostId), buildId, fetch, clientId ?? '')
    return {}
  }
}

const MAX_FETCH_ATTEMPTS = 3

function connected(client: RpcClient | null, retired: AbortSignal | null): Promise<RpcClient> {
  if (client === null) {
    return Promise.reject(new Error('no desktop connection to fetch deferred code from'))
  }
  return new Promise((resolve, reject) => {
    if (retired?.aborted) {
      reject(new Error('the page that asked for deferred code has closed'))
      return
    }
    if (client.getState() === 'connected') {
      resolve(client)
      return
    }
    const onRetired = () => {
      stop()
      reject(new Error('the page that asked for deferred code has closed'))
    }
    const stop = client.onStateChange((state) => {
      if (state === 'connected') {
        stop()
        retired?.removeEventListener('abort', onRetired)
        resolve(client)
      }
    })
    retired?.addEventListener('abort', onRetired, { once: true })
  })
}
