import { useEffect, useState } from 'react'
import type { RpcClient } from '../rpc/rpc-client-contract'
import { startRuntimeCapabilityProbe } from './runtime-capability-probe'

/** Whether the connected host advertises `capability`; false until it says so. */
export function useRuntimeCapability(
  client: RpcClient | null,
  connected: boolean,
  capability: string
): boolean {
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    setSupported(false)
    if (!client || !connected) {
      return
    }
    return startRuntimeCapabilityProbe(client, (capabilities) => {
      setSupported(capabilities.includes(capability))
    })
  }, [client, connected, capability])

  return supported
}
