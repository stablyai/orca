import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import { readFetchResponseJsonWithinLimit } from '../../../shared/fetch-response-body'
import { RelayRegionCatalogSchema, type RelayRegionCatalog } from './relay-region-probe'

const CATALOG_MAX_BYTES = 16 * 1024

export async function fetchRelayRegionCatalog(
  directorUrl: string,
  fetch: typeof globalThis.fetch,
  timeoutMs: number
): Promise<RelayRegionCatalog> {
  if (!isCanonicalDirectorOrigin(directorUrl)) {
    throw new Error('invalid relay director origin')
  }
  const response = await fetch(`${directorUrl}/v1/regions`, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    throw new Error(`relay region catalog failed (${response.status})`)
  }
  const body = await readFetchResponseJsonWithinLimit<unknown>(response, CATALOG_MAX_BYTES, {
    structuralTokens: 64,
    nestingDepth: 8
  })
  const catalog = RelayRegionCatalogSchema.parse(body)
  if (
    catalog.regions.some((entry) =>
      entry.probeOrigins.some((origin) => !isProbeOriginForDirector(origin, directorUrl))
    )
  ) {
    throw new Error('relay probe origin does not belong to the director')
  }
  return catalog
}

// Logs name the director by host so staging and production lines stay
// distinguishable without carrying a full URL through every event.
export function relayDirectorHost(directorUrl: string): string {
  try {
    return new URL(directorUrl).hostname
  } catch {
    return 'invalid'
  }
}

function isCanonicalDirectorOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    return (
      url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
    )
  } catch {
    return false
  }
}

function isProbeOriginForDirector(origin: string, directorUrl: string): boolean {
  return new URL(origin).hostname.endsWith(`.${new URL(directorUrl).hostname}`)
}
