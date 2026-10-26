import { useEffect, useState } from 'react'
import { CODEX_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../src/shared/account-runtime-capabilities'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import {
  codexResetCreditCapabilityRead,
  type MobileCodexResetCapabilityRpcSender
} from './codex-reset-credit-capability-operations'

// Use shared capability constant so host/mobile versions cannot silently drift.
export const MOBILE_CODEX_RESET_CREDIT_CAPABILITY = CODEX_RESET_CREDIT_RUNTIME_CAPABILITY

export async function readCodexResetCreditCapability(
  client: MobileCodexResetCapabilityRpcSender
): Promise<boolean> {
  try {
    const capabilities = codexResetCreditCapabilityRead.interpret(
      await codexResetCreditCapabilityRead.request(client)
    )
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
