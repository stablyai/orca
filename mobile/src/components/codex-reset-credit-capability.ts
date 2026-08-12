import { useEffect, useState } from 'react'
import { CODEX_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'

// Why: source the capability string from the shared contract so a host bump can never
// silently drift from the mobile probe.
export const MOBILE_CODEX_RESET_CREDIT_CAPABILITY = CODEX_RESET_CREDIT_RUNTIME_CAPABILITY

export async function readCodexResetCreditCapability(
  client: Pick<RpcClient, 'sendRequest'>
): Promise<boolean> {
  try {
    const response = await client.sendRequest('status.get')
    if (!response.ok || !response.result || typeof response.result !== 'object') {
      return false
    }
    const capabilities = (response.result as { capabilities?: unknown }).capabilities
    return (
      Array.isArray(capabilities) && capabilities.includes(MOBILE_CODEX_RESET_CREDIT_CAPABILITY)
    )
  } catch {
    return false
  }
}

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
      setSupported(capabilities.includes(MOBILE_CODEX_RESET_CREDIT_CAPABILITY))
    })
  }, [client, connected])

  return supported
}
