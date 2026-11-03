import { z } from 'zod'
import {
  cacheEndpointAuthSnapshot,
  clearEndpointAuthHeadersCache,
  endpointAuthOrigin,
  endpointAuthMutationEpoch,
  normalizeEndpointAuthHeaders,
  noteEndpointAuthHeadersChanged,
  type EndpointAuthHeaders
} from './endpoint-auth-headers'
import {
  getHostCredentialWriteRevision,
  markHostCredentialWrite
} from './host-credential-write-revision'
import {
  deletePairingKeychainItem,
  readPairingKeychainItem,
  writePairingKeychainItem
} from './pairing-keychain'

// Why: SecureStore keys must match [A-Za-z0-9._-] (colons rejected), so use dots as the separator.
const HEADERS_KEY_PREFIX = 'orca.mobile-endpoint-auth.'

const EndpointAuthBundleSchema = z
  .object({
    v: z.literal(2),
    hostId: z.string().min(1),
    origin: z.string(),
    headers: z.record(z.string(), z.string())
  })
  .strict()

function headersKey(hostId: string): string {
  return `${HEADERS_KEY_PREFIX}${hostId}`
}

function parseStoredBundle(
  hostId: string,
  endpoint: string,
  raw: string
): EndpointAuthHeaders | null {
  try {
    const result = EndpointAuthBundleSchema.safeParse(JSON.parse(raw))
    if (
      !result.success ||
      result.data.hostId !== hostId ||
      result.data.origin !== endpointAuthOrigin(endpoint)
    ) {
      return null
    }
    const normalized = normalizeEndpointAuthHeaders(
      Object.entries(result.data.headers).map(([name, value]) => ({ name, value }))
    )
    return normalized.ok ? normalized.headers : null
  } catch {
    return null
  }
}

export async function readEndpointAuthHeaders(
  hostId: string,
  endpoint: string
): Promise<EndpointAuthHeaders | null> {
  const raw = await readPairingKeychainItem(headersKey(hostId))
  return raw === null ? null : parseStoredBundle(hostId, endpoint, raw)
}

export async function writeEndpointAuthHeaders(
  hostId: string,
  headers: EndpointAuthHeaders,
  endpoint: string
): Promise<void> {
  const origin = endpointAuthOrigin(endpoint)
  if (!origin) {
    throw new Error('Edge authentication requires a secure endpoint.')
  }
  // Validate before persistence so the reader accepts every stored bundle.
  const normalized = normalizeEndpointAuthHeaders(
    Object.entries(headers).map(([name, value]) => ({ name, value }))
  )
  if (!normalized.ok) {
    throw new Error(`Invalid edge-auth headers: ${normalized.error}`)
  }
  const validated = EndpointAuthBundleSchema.parse({
    v: 2,
    hostId,
    origin,
    headers: normalized.headers
  })
  markHostCredentialWrite(validated.hostId)
  await writePairingKeychainItem(headersKey(validated.hostId), JSON.stringify(validated))
  noteEndpointAuthHeadersChanged(validated.hostId)
  cacheEndpointAuthSnapshot(validated.hostId, validated.headers, endpoint)
}

export async function deleteEndpointAuthHeaders(hostId: string): Promise<void> {
  // A revision bump would abort removal; the epoch invalidates in-flight reads instead.
  noteEndpointAuthHeadersChanged(hostId)
  await deletePairingKeychainItem(headersKey(hostId))
  clearEndpointAuthHeadersCache(hostId)
}

/** Load headers into memory before opening a client; failures fall back to no headers. */
export async function primeEndpointAuthHeaders(
  hostId: string,
  endpoint: string,
  isCurrent?: () => boolean
): Promise<EndpointAuthHeaders | null> {
  // A concurrent credential mutation must win over this read.
  const revision = getHostCredentialWriteRevision(hostId)
  const epoch = endpointAuthMutationEpoch(hostId)
  const unchanged = () =>
    getHostCredentialWriteRevision(hostId) === revision &&
    endpointAuthMutationEpoch(hostId) === epoch
  try {
    const headers = await readEndpointAuthHeaders(hostId, endpoint)
    // A stale open must not restore credentials cleared by host removal.
    if (!unchanged() || (isCurrent && !isCurrent())) {
      return headers
    }
    cacheEndpointAuthSnapshot(hostId, headers, endpoint)
    return headers
  } catch {
    if (unchanged() && (!isCurrent || isCurrent())) {
      clearEndpointAuthHeadersCache(hostId)
    }
    return null
  }
}
