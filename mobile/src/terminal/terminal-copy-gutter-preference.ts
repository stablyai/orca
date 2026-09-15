import { useEffect, useRef, type RefObject } from 'react'
import { terminalCopyTrimsGutterRead } from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

/**
 * Desktop owns "Trim Gutter on Copy" (GlobalSettings.terminalCopyTrimsGutter);
 * mobile mirrors it so turning the setting off yields verbatim screen cells on
 * every surface. Read once per connection — the mobile RPC has no
 * settings-change stream — and default to on while the read is in flight.
 */
export function useTerminalCopyTrimsGutter(
  client: RpcClient | null,
  connState: ConnectionState
): RefObject<boolean> {
  const trimsGutterRef = useRef(true)

  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }

    let stale = false
    void terminalCopyTrimsGutterRead
      .request(client)
      .then((response) => {
        if (stale) {
          return
        }

        const preference = terminalCopyTrimsGutterRead.interpret(response)

        if (preference.accepted) {
          trimsGutterRef.current = preference.value
        }
      })
      .catch(() => {
        // Best-effort: an unreachable host leaves the on-by-default trim in place.
      })

    return () => {
      stale = true
    }
  }, [client, connState])

  return trimsGutterRef
}
