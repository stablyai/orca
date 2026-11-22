// Composio's full app catalog for Add a connector, as the desktop's ComposioCatalog reads it: one search at
// a time (a newer query drops an older answer), then more pages on Show more.
import { useCallback, useEffect, useRef, useState } from 'react'
import { composioAppsRead } from '../../session/native-chat/transcript/bot-cards/mobile-composio-operations'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

export type ComposioCatalog = {
  apps: { slug: string; name: string }[]
  loading: boolean
  failed: boolean
  more: (() => void) | null
}

// Typing settles this long before the catalog is asked.
const SEARCH_SETTLE_MS = 300

/** Null `search` reads nothing. */
export function useComposioCatalog(
  client: RpcClient | null,
  botId: string,
  search: string | null
): ComposioCatalog {
  const [state, setState] = useState<{
    search: string | null
    apps: { slug: string; name: string }[]
    cursor: string | null
    loading: boolean
    failed: boolean
  }>({ search: null, apps: [], cursor: null, loading: false, failed: false })
  const asked = useRef(0)
  const read = useCallback(
    (query: string, cursor: string | null) => {
      if (!client) {
        return
      }
      const request = ++asked.current
      setState((before) => ({ ...before, search: query, loading: true, failed: false }))
      void composioAppsRead
        .request(client, {
          botId,
          ...(query ? { search: query } : {}),
          ...(cursor ? { cursor } : {})
        })
        .then((reply) => composioAppsRead.interpret(reply))
        .then(
          (page) => {
            if (request === asked.current) {
              setState((before) => ({
                search: query,
                apps: cursor ? [...before.apps, ...page.apps] : page.apps,
                cursor: page.nextCursor,
                loading: false,
                failed: false
              }))
            }
          },
          () => {
            if (request === asked.current) {
              setState((before) => ({ ...before, loading: false, failed: true }))
            }
          }
        )
    },
    [client, botId]
  )
  useEffect(() => {
    if (search === null) {
      return
    }
    const timer = setTimeout(() => read(search, null), SEARCH_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [search, read])
  const current = search !== null && state.search === search
  return {
    apps: current ? state.apps : [],
    loading: search !== null && (!current || state.loading),
    failed: current && state.failed,
    more: current && state.cursor && !state.loading ? () => read(search, state.cursor) : null
  }
}
