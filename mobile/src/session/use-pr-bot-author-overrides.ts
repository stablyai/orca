import { botOverridesRead } from '../transport/settings-read-operations'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { createBotAuthorOverrideSet } from '../../../src/shared/pr-bot-author-overrides'

// Settings have no mobile change stream; refresh overrides alongside PR data so desktop bot classifications stay current.
export function usePRBotAuthorOverrides(
  client: RpcClient | null,
  connState: ConnectionState,
  refreshKey?: unknown
): ReadonlySet<string> {
  const [logins, setLogins] = useState<string[]>([])
  const sourceClientRef = useRef<RpcClient | null>(null)

  useEffect(() => {
    if (!client || connState !== 'connected') {
      sourceClientRef.current = null
      setLogins([])
      return
    }
    if (sourceClientRef.current !== client) {
      // Host replacement must not render the previous runtime’s bot overrides.
      sourceClientRef.current = client
      setLogins([])
    }
    if (refreshKey == null) {
      return
    }
    let stale = false
    void botOverridesRead
      .request(client)
      .then((response) => {
        if (stale) {
          return
        }
        const overrides = botOverridesRead.interpret(response)
        if (overrides.accepted) {
          setLogins(overrides.value)
        }
      })
      .catch(() => {
        // Without overrides, retain heuristic bot classification.
      })
    return () => {
      stale = true
    }
  }, [client, connState, refreshKey])

  return useMemo(() => createBotAuthorOverrideSet(logins), [logins])
}
