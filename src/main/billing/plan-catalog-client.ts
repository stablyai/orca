// Billing's public plan catalog (GET /v1/plans) with an on-disk last-good copy. Revalidates with
// If-None-Match; offline it serves the last copy for up to a week, after that nothing (the plans
// dialog then shows an error with Retry: a price is never guessed). Pure: fetch, paths and the
// clock are injected, so it is testable without Electron.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { OrcaPlanCatalog, OrcaPlanCatalogResult } from '../../shared/orca-billing-plans'
import { parsePlanCatalog } from './plan-catalog-schema'

const REQUEST_TIMEOUT_MS = 15_000
/** How old the last good copy may be and still be shown when billing can't be reached. */
export const PLAN_CATALOG_MAX_STALE_MS = 7 * 24 * 3600 * 1000
const MAX_BODY_BYTES = 256 * 1024

const CacheFile = z.object({
  billingApiUrl: z.string(),
  etag: z.string().max(200).nullable(),
  fetchedAt: z.number(),
  body: z.unknown()
})
type CacheEntry = z.infer<typeof CacheFile>

async function readCache(
  file: string,
  billingApiUrl: string
): Promise<{ entry: CacheEntry; catalog: OrcaPlanCatalog } | null> {
  try {
    const parsed = CacheFile.safeParse(JSON.parse(await readFile(file, 'utf8')))
    if (!parsed.success || parsed.data.billingApiUrl !== billingApiUrl) {
      return null
    }
    const catalog = parsePlanCatalog(parsed.data.body)
    return catalog ? { entry: parsed.data, catalog } : null
  } catch {
    return null
  }
}

async function writeCache(file: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(entry))
    await rename(temp, file)
  } catch {
    // The cache is an optimization; a failed write only means no offline copy.
  }
}

export type PlanCatalogLoadOptions = {
  billingApiUrl: string
  cacheFile: string
  now: number
  fetchImpl?: typeof fetch
}

export async function loadPlanCatalog(
  options: PlanCatalogLoadOptions
): Promise<OrcaPlanCatalogResult> {
  const { billingApiUrl, cacheFile, now } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const cached = await readCache(cacheFile, billingApiUrl)
  const fallback = (error: string): OrcaPlanCatalogResult =>
    cached && now - cached.entry.fetchedAt < PLAN_CATALOG_MAX_STALE_MS
      ? {
          status: 'ok',
          catalog: cached.catalog,
          source: 'cache',
          fetchedAt: cached.entry.fetchedAt
        }
      : { status: 'failed', error }
  let response: Response
  try {
    response = await fetchImpl(new URL('v1/plans', `${billingApiUrl}/`).toString(), {
      method: 'GET',
      headers: cached?.entry.etag ? { 'if-none-match': cached.entry.etag } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    return fallback(error instanceof Error ? error.message : 'plan_catalog_unreachable')
  }
  if (response.status === 304 && cached) {
    await writeCache(cacheFile, { ...cached.entry, fetchedAt: now })
    return { status: 'ok', catalog: cached.catalog, source: 'live', fetchedAt: now }
  }
  if (response.status === 404) {
    // A billing service from before the catalog: the caller uses the entitlement's offers.
    return { status: 'unsupported' }
  }
  if (!response.ok) {
    return fallback(`plan_catalog_${response.status}`)
  }
  const text = await response.text().catch(() => '')
  let body: unknown = null
  try {
    body = text.length <= MAX_BODY_BYTES ? JSON.parse(text) : null
  } catch {
    body = null
  }
  const catalog = parsePlanCatalog(body)
  if (!catalog) {
    return fallback('invalid_plan_catalog')
  }
  const etag = response.headers.get('etag')
  await writeCache(cacheFile, {
    billingApiUrl,
    etag: etag && etag.length <= 200 ? etag : null,
    fetchedAt: now,
    body
  })
  return { status: 'ok', catalog, source: 'live', fetchedAt: now }
}
