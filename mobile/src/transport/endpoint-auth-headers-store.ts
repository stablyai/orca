import { z } from 'zod'
import {
  cacheEndpointAuthSnapshot,
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
    v: z.literal(1),
    hostId: z.string().min(1),
    headers: z.record(z.string(), z.string())
  })
  .strict()

function headersKey(hostId: string): string {
  return `${HEADERS_KEY_PREFIX}${hostId}`
}

function parseStoredBundle(hostId: string, raw: string): EndpointAuthHeaders | null {
  try {
    const result = EndpointAuthBundleSchema.safeParse(JSON.parse(raw))
    if (!result.success || result.data.hostId !== hostId) {
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

export async function readEndpointAuthHeaders(hostId: string): Promise<EndpointAuthHeaders | null> {
  const raw = await readPairingKeychainItem(headersKey(hostId))
  return raw === null ? null : parseStoredBundle(hostId, raw)
}

export async function writeEndpointAuthHeaders(
  hostId: string,
  headers: EndpointAuthHeaders
): Promise<void> {
  // Why: the reader enforces the same schema — normalize first so a write can never persist
  // what a later read would reject. Names in the error are truncated; values never appear.
  const normalized = normalizeEndpointAuthHeaders(
    Object.entries(headers).map(([name, value]) => ({ name, value }))
  )
  if (!normalized.ok) {
    throw new Error(`Invalid edge-auth headers: ${normalized.error}`)
  }
  const validated = EndpointAuthBundleSchema.parse({
    v: 1,
    hostId,
    headers: normalized.headers
  })
  markHostCredentialWrite(validated.hostId)
  await writePairingKeychainItem(headersKey(validated.hostId), JSON.stringify(validated))
  noteEndpointAuthHeadersChanged(validated.hostId)
  cacheEndpointAuthSnapshot(validated.hostId, validated.headers)
}

export async function deleteEndpointAuthHeaders(hostId: string): Promise<void> {
  // Why: no revision bump here — the deferred removal chain treats any revision change as a
  // concurrent re-pair and aborts; the mutation epoch below is what invalidates in-flight primes.
  noteEndpointAuthHeadersChanged(hostId)
  await deletePairingKeychainItem(headersKey(hostId))
  cacheEndpointAuthSnapshot(hostId, null)
}

/** Load headers into memory before opening a client; failures fall back to no headers. */
export async function primeEndpointAuthHeaders(
  hostId: string,
  isCurrent?: () => boolean
): Promise<EndpointAuthHeaders | null> {
  // Why: an auth mutation landing mid-read must win — only cache when neither the shared
  // credential revision nor the auth mutation epoch moved underneath this read.
  const revision = getHostCredentialWriteRevision(hostId)
  const epoch = endpointAuthMutationEpoch(hostId)
  const unchanged = () =>
    getHostCredentialWriteRevision(hostId) === revision &&
    endpointAuthMutationEpoch(hostId) === epoch
  try {
    const headers = await readEndpointAuthHeaders(hostId)
    // Why: a removal may have cleared the cache while this read was in flight — a stale
    // open must not resurrect it. The opener rechecks ownership right after this anyway.
    if (!unchanged() || (isCurrent && !isCurrent())) {
      return headers
    }
    cacheEndpointAuthSnapshot(hostId, headers)
    return headers
  } catch {
    if (unchanged()) {
      cacheEndpointAuthSnapshot(hostId, null)
    }
    return null
  }
}
