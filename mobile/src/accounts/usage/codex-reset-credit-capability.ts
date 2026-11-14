import { useEffect, useState } from 'react'
import { CODEX_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../../src/shared/account-runtime-capabilities'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { startRuntimeCapabilityProbe } from '../../transport/connection/runtime-capability-probe'

export function useCodexResetCreditCapability(
  client: RpcClient | null,
  connected: boolean
): boolean {
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    setSupported(false)
    if (!client || !connected) {
      return
    }
    return startRuntimeCapabilityProbe(client, (capabilities) => {
      setSupported(capabilities.includes(CODEX_RESET_CREDIT_RUNTIME_CAPABILITY))
    })
  }, [client, connected])

  return supported
}
