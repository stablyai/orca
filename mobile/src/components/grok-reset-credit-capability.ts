import { useEffect, useMemo, useState } from 'react'
import { GROK_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'

export const MOBILE_GROK_RESET_CREDIT_CAPABILITY = GROK_RESET_CREDIT_RUNTIME_CAPABILITY

type CapabilityObservation = {
  probeIdentity: object
  supported: boolean
}

export function useGrokResetCreditCapability(
  client: RpcClient | null,
  connected: boolean
): boolean {
  const [observation, setObservation] = useState<CapabilityObservation | null>(null)
  const probeIdentity = useMemo(() => ({}), [client, connected])

  useEffect(() => {
    if (!client || !connected) {
      return
    }
    return startRuntimeCapabilityProbe(client, (capabilities) => {
      setObservation({
        probeIdentity,
        supported: capabilities.includes(MOBILE_GROK_RESET_CREDIT_CAPABILITY)
      })
    })
  }, [client, connected, probeIdentity])

  return connected && observation?.probeIdentity === probeIdentity && observation.supported
}
