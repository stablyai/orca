import { z } from 'zod'
import { readFetchResponseJsonWithinLimit } from '../../../shared/fetch-response-body'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'

export const RELAY_REGIONS = ['us-central1', 'asia-east2'] as const
export type RelayRegion = (typeof RELAY_REGIONS)[number]
export type RelayRegionCatalog = {
  v: 1
  regions: { region: RelayRegion; probeOrigins: string[] }[]
}

const CATALOG_MAX_BYTES = 16 * 1024
const RelayRegionSchema = z.enum(RELAY_REGIONS)
const RelayProbeOriginSchema = z.string().max(2_048).refine(isCanonicalRelayProbeOrigin)
const RelayRegionCatalogSchema = z
  .object({
    v: z.literal(1),
    regions: z.array(z.unknown())
  })
  .passthrough()
const RelayRegionCatalogEntrySchema = z.object({ region: z.string().max(128) }).passthrough()
const KnownRelayRegionCatalogEntrySchema = z
  .object({ region: RelayRegionSchema, probeOrigins: z.array(z.unknown()).min(1) })
  .passthrough()

export function parseRelayRegion(value: unknown): RelayRegion | undefined {
  const parsed = RelayRegionSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

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
    structuralTokens: 256,
    nestingDepth: 8
  })
  return parseRelayRegionCatalog(body, directorUrl)
}

export function isCanonicalRelayProbeOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value
  } catch {
    return false
  }
}

function parseRelayRegionCatalog(body: unknown, directorUrl: string): RelayRegionCatalog {
  const parsed = RelayRegionCatalogSchema.safeParse(body)
  if (!parsed.success) {
    throw new Error('invalid relay region catalog')
  }
  const regions = new Set<RelayRegion>()
  const origins = new Set<string>()
  const known: RelayRegionCatalog['regions'] = []
  for (const rawEntry of parsed.data.regions) {
    const entry = RelayRegionCatalogEntrySchema.safeParse(rawEntry)
    if (!entry.success) {
      continue
    }
    const region = parseRelayRegion(entry.data.region)
    if (!region) {
      continue
    }
    const knownEntry = KnownRelayRegionCatalogEntrySchema.safeParse(rawEntry)
    if (!knownEntry.success) {
      throw new Error('invalid relay region entry')
    }
    if (regions.has(region)) {
      throw new Error('duplicate relay region')
    }
    regions.add(region)
    const probeOrigins = parseProbeOrigins(knownEntry.data.probeOrigins, origins, directorUrl)
    known.push({ region, probeOrigins })
  }
  return { v: 1, regions: known }
}

function parseProbeOrigins(
  rawOrigins: unknown[],
  origins: Set<string>,
  directorUrl: string
): string[] {
  const parsed: string[] = []
  for (const rawOrigin of rawOrigins.slice(0, 2)) {
    const origin = RelayProbeOriginSchema.safeParse(rawOrigin)
    if (!origin.success || !isProbeOriginForDirector(origin.data, directorUrl)) {
      throw new Error('invalid relay probe origin')
    }
    if (origins.has(origin.data)) {
      throw new Error('duplicate relay probe origin')
    }
    origins.add(origin.data)
    parsed.push(origin.data)
  }
  return parsed
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
