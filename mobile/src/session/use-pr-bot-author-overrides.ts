import { useEffect, useMemo, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcSuccess } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { createBotAuthorOverrideSet } from '../../../src/shared/pr-bot-author-overrides'

// Fetches the desktop's manual bot-author overrides (GlobalSettings.prBotAuthorOverrides,
// marked from the desktop Comments panel) so the mobile Humans/Bots comment filter
// classifies the same authors as bots. There is no settings-change stream over the
// mobile RPC, so callers pass a refreshKey (e.g. the PR payload identity) to re-fetch
// alongside PR data instead of holding a one-shot snapshot for the whole session.
export function usePRBotAuthorOverrides(
  client: RpcClient | null,
  connState: ConnectionState,
  refreshKey?: unknown
): ReadonlySet<string> {
  const [logins, setLogins] = useState<string[]>([])

  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let stale = false
    void client
      .sendRequest('settings.get')
      .then((response) => {
        if (stale || !response.ok) {
          return
        }
        const result = (response as RpcSuccess).result as {
          settings?: { prBotAuthorOverrides?: unknown }
        } | null
        const overrides = result?.settings?.prBotAuthorOverrides
        if (Array.isArray(overrides)) {
          setLogins(overrides.filter((login): login is string => typeof login === 'string'))
        }
      })
      .catch(() => {
        // Best-effort: without the setting the heuristics still classify most bots.
      })
    return () => {
      stale = true
    }
  }, [client, connState, refreshKey])

  return useMemo(() => createBotAuthorOverrideSet(logins), [logins])
}
