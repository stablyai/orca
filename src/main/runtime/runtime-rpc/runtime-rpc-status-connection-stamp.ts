import type { DeviceScope } from '../device-registry'

// Stamp proven scope and per-connection capabilities at transport boundary; status.get has no connection context.
export function injectDeviceScope(
  response: string,
  scope: DeviceScope,
  connectionCapabilities: readonly string[]
): string {
  try {
    const parsed: unknown = JSON.parse(response)
    if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result)) {
      return response
    }
    const { result } = parsed
    result.deviceScope = scope
    if (connectionCapabilities.length > 0 && Array.isArray(result.capabilities)) {
      result.capabilities = [...result.capabilities, ...connectionCapabilities]
    }
    return JSON.stringify(parsed)
  } catch {
    return response
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
