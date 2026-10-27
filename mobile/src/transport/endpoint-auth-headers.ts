import { endpointScheme } from './host-endpoint'
import { normalizePairingUrl } from '../../../src/shared/network/pairing-url'

export type EndpointAuthHeaders = Record<string, string>

export type NormalizeEndpointAuthHeadersResult =
  | { ok: true; headers: EndpointAuthHeaders }
  | { ok: false; error: string }

const MAX_HEADERS = 8
const MAX_NAME_LENGTH = 128
// Bound each value before storing it in the OS keychain.
const MAX_VALUE_LENGTH = 1024
const MAX_INVALID_NAME_PREVIEW = 64
// RFC 9110 token: what a reverse proxy accepts as a header name on the wire.
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && HEADER_NAME_PATTERN.test(name)
}

function hasInvalidHeaderCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code >= 0x7f) {
      return true
    }
  }
  return false
}

function isValidValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VALUE_LENGTH && !hasInvalidHeaderCharacter(value)
}

export function normalizeEndpointAuthHeaders(rows: unknown): NormalizeEndpointAuthHeadersResult {
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'Headers must be a list.' }
  }
  const headers: EndpointAuthHeaders = {}
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      return { ok: false, error: 'Each header must be a name/value pair.' }
    }
    const rawName = 'name' in row ? row.name : undefined
    const rawValue = 'value' in row ? row.value : undefined
    const trimmedName = typeof rawName === 'string' ? rawName.trim() : ''
    const trimmedValue = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!trimmedName && !trimmedValue) {
      continue
    }
    if (!isValidName(trimmedName)) {
      return {
        ok: false,
        error: `Invalid header name: "${trimmedName.slice(0, MAX_INVALID_NAME_PREVIEW)}".`
      }
    }
    if (!isValidValue(trimmedValue)) {
      return { ok: false, error: `Invalid value for header "${trimmedName}".` }
    }
    const duplicate = Object.keys(headers).find(
      (existing) => existing.toLowerCase() === trimmedName.toLowerCase()
    )
    if (duplicate) {
      delete headers[duplicate]
    }
    // Treat every header name as data, including __proto__.
    Object.defineProperty(headers, trimmedName, {
      value: trimmedValue,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  if (Object.keys(headers).length > MAX_HEADERS) {
    return { ok: false, error: `At most ${MAX_HEADERS} headers are supported.` }
  }
  return { ok: true, headers }
}

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

export function endpointAuthOrigin(endpoint: string): string | null {
  const normalized = normalizePairingUrl(endpoint)
  return normalized?.startsWith('wss://') ? new URL(normalized).origin : null
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
