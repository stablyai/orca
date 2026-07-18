import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'

// Mirrors CODEX_RESET_CREDIT_RUNTIME_CAPABILITY in the shared runtime protocol.
export const MOBILE_CODEX_RESET_CREDIT_CAPABILITY = 'accounts.codex-reset-credit.v1'

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
  client: Pick<RpcClient, 'sendRequest'> | null,
  connected: boolean
): boolean {
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    setSupported(false)
    if (!client || !connected) {
      return
    }
    let stale = false
    void readCodexResetCreditCapability(client).then((nextSupported) => {
      if (!stale) {
        setSupported(nextSupported)
      }
    })
    return () => {
      stale = true
    }
  }, [client, connected])

  return supported
}
