import { useEffect } from 'react'
import { useForceReconnect } from './client-context'
import { recoverMobileRelayPairing } from './mobile-relay-pairing-recovery'

export function MobileRelayPairingRecoveryBridge(): null {
  const forceReconnect = useForceReconnect()

  useEffect(() => {
    let disposed = false
    void recoverMobileRelayPairing({
      onHostPublished: (host) => {
        if (!disposed) {
          void forceReconnect(host.id, host).catch(() => {})
        }
      }
    })
    return () => {
      disposed = true
    }
  }, [forceReconnect])

  return null
}
