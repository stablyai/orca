import { endpointScheme } from './host-endpoint'

import {
  endpointAuthOrigin,
  type EndpointAuthHeaders
} from '../../../src/shared/network/endpoint-auth-headers'
export {
  endpointAuthOrigin,
  normalizeEndpointAuthHeaders
} from '../../../src/shared/network/endpoint-auth-headers'
export type {
  EndpointAuthHeaders,
  NormalizeEndpointAuthHeadersResult
} from '../../../src/shared/network/endpoint-auth-headers'

// Secret values must never reach connection diagnostics.
export function describeEndpointAuthHeadersForLog(headers: EndpointAuthHeaders | null): string {
  if (!headers || Object.keys(headers).length === 0) {
    return 'no edge-auth headers'
  }
  return `edge-auth headers: ${Object.keys(headers).join(', ')}`
}

// Browser controls and stores exclude this native-only constructor path.
export function createEndpointAuthSocket(url: string, headers: EndpointAuthHeaders): WebSocket {
  // React Native's third constructor argument is absent from DOM WebSocket types.
  return Reflect.construct(WebSocket, [url, undefined, { headers, followRedirects: false }])
}

export function edgeAuthHeadersForEndpoint(
  endpoint: string,
  headers: EndpointAuthHeaders | null
): EndpointAuthHeaders | null {
  if (!headers || Object.keys(headers).length === 0) {
    return null
  }
  return endpointScheme(endpoint) === 'wss' ? headers : null
}

export function checkEdgeAuthEndpoint(
  headers: EndpointAuthHeaders | null,
  endpoint: string | undefined
): { blocked: boolean; error: string | null } {
  if (!headers || Object.keys(headers).length === 0) {
    return { blocked: false, error: null }
  }
  if (endpoint && endpointScheme(endpoint) === 'wss') {
    return { blocked: false, error: null }
  }
  return {
    blocked: true,
    error: 'Edge authentication needs a wss:// address — headers are never sent over ws://.'
  }
}

const snapshotByHostId = new Map<string, { origin: string; headers: EndpointAuthHeaders }>()
const mutationEpochByHostId = new Map<string, number>()

// Invalidate reads that overlap a credential mutation.
export function noteEndpointAuthHeadersChanged(hostId: string): void {
  mutationEpochByHostId.set(hostId, (mutationEpochByHostId.get(hostId) ?? 0) + 1)
}

export function endpointAuthMutationEpoch(hostId: string): number {
  return mutationEpochByHostId.get(hostId) ?? 0
}

// Socket construction reads synchronously after credential priming.
export function cacheEndpointAuthSnapshot(
  hostId: string,
  headers: EndpointAuthHeaders | null,
  endpoint: string
): void {
  const origin = endpointAuthOrigin(endpoint)
  if (origin && headers && Object.keys(headers).length > 0) {
    snapshotByHostId.set(hostId, { origin, headers })
    return
  }
  snapshotByHostId.delete(hostId)
}

export function peekEndpointAuthHeaders(
  hostId: string,
  endpoint: string
): EndpointAuthHeaders | null {
  const snapshot = snapshotByHostId.get(hostId)
  return snapshot?.origin === endpointAuthOrigin(endpoint) ? snapshot.headers : null
}

export function clearEndpointAuthHeadersCache(hostId: string): void {
  snapshotByHostId.delete(hostId)
}
