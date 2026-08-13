import {
  hostSupportsSessionTabTerminalCreateAttributionDisable,
  MOBILE_TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE
} from '../../../src/shared/legacy-terminal-attribution-env'
import type { RpcClient } from '../transport/rpc-client'

export const MOBILE_TERMINAL_CREATE_RPC_TIMEOUT_MS = 30_000
export const MOBILE_TERMINAL_CREATE_RPC_OPTIONS = {
  timeoutMs: MOBILE_TERMINAL_CREATE_RPC_TIMEOUT_MS,
  budgetSpansConnect: true
} as const

export type MobileTerminalAttributionAuthority = Readonly<{ runtimeId: string }>

export async function assertMobileTerminalAttributionDisableSupported(
  client: Pick<RpcClient, 'sendRequest'>
): Promise<MobileTerminalAttributionAuthority> {
  const response = await client.sendRequest(
    'status.get',
    undefined,
    MOBILE_TERMINAL_CREATE_RPC_OPTIONS
  )
  if (!response.ok) {
    throw new Error(response.error?.message || 'Unable to verify the workspace host version.')
  }
  if (!hostSupportsSessionTabTerminalCreateAttributionDisable(response.result)) {
    throw new Error(MOBILE_TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE)
  }
  const runtimeId = Reflect.get(response.result as object, 'runtimeId')
  if (typeof runtimeId !== 'string' || !runtimeId) {
    throw new Error(MOBILE_TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE)
  }
  return Object.freeze({ runtimeId })
}
