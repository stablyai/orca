import { net } from 'electron'
import type { NpmPackageInfo, NpmPackageInfoResult } from '../../shared/npm-package-info-types'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { extractRepositoryUrl, toHttpsUrl } from './npm-manifest-urls'

const REGISTRY_BASE_URL = 'https://registry.npmjs.org'
const FETCH_TIMEOUT_MS = 8000

function parsePackument(packageName: string, doc: Record<string, unknown>): NpmPackageInfo | null {
  const distTags = doc['dist-tags'] as Record<string, unknown> | undefined
  const latestVersion = typeof distTags?.latest === 'string' ? distTags.latest : null
  const time = doc.time as Record<string, unknown> | undefined
  const latestPublishedAt =
    latestVersion && typeof time?.[latestVersion] === 'string'
      ? (time[latestVersion] as string)
      : null
  return {
    packageName,
    description: typeof doc.description === 'string' ? doc.description : null,
    latestVersion,
    latestPublishedAt,
    homepageUrl: toHttpsUrl(doc.homepage),
    repositoryUrl: extractRepositoryUrl(doc.repository),
    source: 'registry-http'
  }
}

/**
 * Reads registry metadata via public HTTP for SSH/runtime-hosted workspaces
 * (and as the local fallback when npm is unresolvable). Requests the full
 * packument, not `application/vnd.npm.install-v1+json`, because the
 * abbreviated doc omits `description`, `homepage` and `time`.
 */
export async function npmRegistryHttpLookup(packageName: string): Promise<NpmPackageInfoResult> {
  const url = `${REGISTRY_BASE_URL}/${packageName.replace(/\//g, '%2F')}`

  let res: Awaited<ReturnType<typeof net.fetch>>
  try {
    res = await net.fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError'
    return { status: 'unavailable', reason: isTimeout ? 'timeout' : 'network' }
  }

  if (!res.ok) {
    await cancelUnreadResponseBody(res)
    return res.status === 404 ? { status: 'not-found' } : { status: 'unavailable', reason: 'error' }
  }

  const doc = (await res.json()) as Record<string, unknown>
  const info = parsePackument(packageName, doc)
  return info ? { status: 'ok', info } : { status: 'unavailable', reason: 'error' }
}
