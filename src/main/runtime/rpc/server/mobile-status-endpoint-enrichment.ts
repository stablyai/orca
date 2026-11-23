import type { RpcRequest } from '../core'
import type { RpcTransport } from '../transport'
import { discoverAuthenticatedMobileTailnetEndpoint } from './pairing/network/mobile-tailnet-fallback'
import type { DeviceScope } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

// Add paired-device-only metadata after a successful status.get, without changing the main RPC contract.
export function enrichAuthenticatedMobileStatusReply(
  response: string,
  scope: DeviceScope,
  tailnetEndpoint?: string
): string {
  try {
    const parsed: unknown = JSON.parse(response)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('ok' in parsed) ||
      parsed.ok !== true ||
      !('result' in parsed) ||
      !parsed.result ||
      typeof parsed.result !== 'object'
    ) {
      return response
    }
    Object.assign(parsed.result, {
      deviceScope: scope,
      ...(tailnetEndpoint ? { tailnetEndpoint } : {})
    })
    return JSON.stringify(parsed)
  } catch {
    return response
  }
}

// Do not enumerate host interfaces for liveness probes, unauthenticated devices, or routed status.
function mayAdvertiseMobileTailnetEndpoint(
  request: RpcRequest,
  scope: DeviceScope,
  authenticated: boolean
): boolean {
  if (
    !authenticated ||
    scope !== 'mobile' ||
    request.method !== 'status.get' ||
    request.executionHost !== undefined
  ) {
    return false
  }
  const params = request.params
  return !(params && typeof params === 'object' && 'probe' in params && params.probe === true)
}

export async function discoverMobileStatusTailnetEndpoint(
  request: RpcRequest,
  scope: DeviceScope,
  authenticated: boolean,
  boundHost: string | null,
  transports: readonly RpcTransport[]
): Promise<string | undefined> {
  return mayAdvertiseMobileTailnetEndpoint(request, scope, authenticated)
    ? discoverAuthenticatedMobileTailnetEndpoint(boundHost, transports)
    : undefined
}
