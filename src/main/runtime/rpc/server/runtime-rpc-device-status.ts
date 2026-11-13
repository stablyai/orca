import type { RpcResponse } from '../core'
import type { DeviceScope } from '../../../../shared/runtime-session-contracts'

// Stamp proven scope at transport boundary; status.get has no connection context.
export function injectDeviceScope(response: string, scope: DeviceScope): string {
  try {
    const parsed = JSON.parse(response) as RpcResponse
    if (parsed.ok !== true || typeof parsed.result !== 'object' || parsed.result === null) {
      return response
    }
    ;(parsed.result as Record<string, unknown>).deviceScope = scope
    return JSON.stringify(parsed)
  } catch {
    return response
  }
}
