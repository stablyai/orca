import { endpointScheme } from './host-endpoint'

export type EndpointAuthHeaders = Record<string, string>

export type NormalizeEndpointAuthHeadersResult =
  | { ok: true; headers: EndpointAuthHeaders }
  | { ok: false; error: string }

const MAX_HEADERS = 8
const MAX_NAME_LENGTH = 128
// Why: SecureStore values live in the OS keychain, which rejects large payloads;
// service tokens are tens of bytes, so 1 KiB per value leaves ample headroom.
const MAX_VALUE_LENGTH = 1024
const MAX_INVALID_NAME_PREVIEW = 64
// RFC 9110 token: what a reverse proxy accepts as a header name on the wire.
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && HEADER_NAME_PATTERN.test(name)
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function isValidValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VALUE_LENGTH && !hasControlChar(value)
}

/** Validate raw name/value rows (UI input); drops blank rows, last duplicate name wins. */
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
    headers[trimmedName] = trimmedValue
  }
  if (Object.keys(headers).length > MAX_HEADERS) {
    return { ok: false, error: `At most ${MAX_HEADERS} headers are supported.` }
  }
  return { ok: true, headers }
}

/** Names only — values must never reach logs, diagnostics, or pairing payloads. */
export function describeEndpointAuthHeadersForLog(headers: EndpointAuthHeaders | null): string {
  if (!headers || Object.keys(headers).length === 0) {
    return 'no edge-auth headers'
  }
  return `edge-auth headers: ${Object.keys(headers).join(', ')}`
}

/** Native-only: React Native accepts handshake headers; browsers and the web bridge do not.
 * Web callers structurally cannot reach this (no-op store sibling keeps headers null, and the
 * edit screen hides the controls on web), so there is no Platform gate here by design. */
export function createEndpointAuthSocket(url: string, headers: EndpointAuthHeaders): WebSocket {
  // Why Reflect: the DOM lib type only knows the two-arg constructor, so the third arg cannot be
  // written directly; React Native's runtime WebSocket accepts (url, protocols, { headers }).
  return Reflect.construct(WebSocket, [url, undefined, { headers }])
}

/** Fail closed: headers ride only encrypted transports, never ws:// cleartext. */
export function edgeAuthHeadersForEndpoint(
  endpoint: string,
  headers: EndpointAuthHeaders | null
): EndpointAuthHeaders | null {
  if (!headers || Object.keys(headers).length === 0) {
    return null
  }
  return endpointScheme(endpoint) === 'wss' ? headers : null
}

/** Editor-side companion: whether headers are blocked for an endpoint, and why. */
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

const snapshotByHostId = new Map<string, EndpointAuthHeaders>()
const mutationEpochByHostId = new Map<string, number>()

/** Bumped by every auth mutation so in-flight primes can detect a mid-read change. */
export function noteEndpointAuthHeadersChanged(hostId: string): void {
  mutationEpochByHostId.set(hostId, (mutationEpochByHostId.get(hostId) ?? 0) + 1)
}

export function endpointAuthMutationEpoch(hostId: string): number {
  return mutationEpochByHostId.get(hostId) ?? 0
}

/** In-memory snapshot for the sync dial path; primed from the store before open. */
export function cacheEndpointAuthSnapshot(
  hostId: string,
  headers: EndpointAuthHeaders | null
): void {
  if (headers && Object.keys(headers).length > 0) {
    snapshotByHostId.set(hostId, headers)
    return
  }
  snapshotByHostId.delete(hostId)
}

/** Sync read for the dial path; empty when never primed or cleared. */
export function peekEndpointAuthHeaders(hostId: string): EndpointAuthHeaders | null {
  return snapshotByHostId.get(hostId) ?? null
}

export function clearEndpointAuthHeadersCache(hostId: string): void {
  snapshotByHostId.delete(hostId)
}
