import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'

// Why: the browser screencast pane must tear down and recreate its browser.screencast
// subscription (resetting the double-buffer render state) when the transport reconnects,
// or the display freezes on the last decoded frame while input RPCs keep landing.
// Returns a value that changes only on a REconnect, to drive a subscribe-effect dep.
export function useBrowserScreencastReconnectSignal(client: RpcClient | null): number {
  const [reconnectSignal, setReconnectSignal] = useState(0)
  useEffect(() => {
    if (!client) {
      return
    }
    let prev = client.getState()
    let everConnected = prev === 'connected'
    return client.onStateChange((next) => {
      // Why: a fresh entry into 'connected' (direct-socket recovery or relay migrateTo)
      // after we were already connected once is a reconnect — bump so dependents reset.
      if (next === 'connected' && prev !== 'connected') {
        if (everConnected) {
          setReconnectSignal((value) => value + 1)
        }
        everConnected = true
      }
      prev = next
    })
  }, [client])
  return reconnectSignal
}
