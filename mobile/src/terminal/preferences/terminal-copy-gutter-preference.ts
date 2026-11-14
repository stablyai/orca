import { useEffect, useRef, type RefObject } from 'react'
import { terminalCopyTrimsGutterRead } from './terminal-copy-settings-operations'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'

// Mirror desktop copy-gutter policy once per connection; mobile has no settings stream and defaults trimming on.
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
        // Keep default trimming when the host is unreachable.
      })
    return () => {
      stale = true
    }
  }, [client, connState])

  return trimsGutterRef
}
