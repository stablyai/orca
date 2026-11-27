import { isKnownRasterImageMimeType } from '../../../../shared/file-preview/raster-image-preview-limits'
import { getMainHttpClient } from '../../../network/http-client'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'

export const REPO_ICON_FETCH_MAX_BYTES = 64 * 1024
export const REPO_ICON_FETCH_MAX_REDIRECTS = 3
export const REPO_ICON_FETCH_TIMEOUT_MS = 5_000

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type RepoIconFetch = (url: string, init: RequestInit) => Promise<Response>
export type FetchedRepoIcon = { mimeType: string; bytes: Uint8Array }

/** This host's fetch for icons; the desktop net.fetch wrapper rejects manual redirects. */
export const runtimeIconFetch: RepoIconFetch = (url, init) => {
  const manualRedirectFetch = getRuntimeDesktopSurface().fetchRepoIcon
  return manualRedirectFetch ? manualRedirectFetch(url, init) : getMainHttpClient().fetch(url, init)
}

function httpsUrl(raw: string, base?: URL): URL | null {
  try {
    const url = new URL(raw, base)
    return url.protocol === 'https:' && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

async function discardBody(response: Response): Promise<void> {
  // Why: an unread undici body can crash the process (orca#8695).
  await response.body?.cancel().catch(() => {})
}

async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response)
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) {
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Fetch HTTPS without cookies, at most three HTTPS redirects and `maxBytes` under one deadline. Failure returns null for fallback, without retry. `allows` vets every hop. */
export async function fetchRemoteRepoIcon(
  rawUrl: string,
  fetch: RepoIconFetch,
  timeoutMs = REPO_ICON_FETCH_TIMEOUT_MS,
  allows: (url: URL) => boolean = () => true,
  maxBytes = REPO_ICON_FETCH_MAX_BYTES
): Promise<FetchedRepoIcon | null> {
  const signal = AbortSignal.timeout(timeoutMs)
  const allowed = (url: URL | null): URL | null => (url && allows(url) ? url : null)
  let url = allowed(httpsUrl(rawUrl))
  try {
    for (let redirects = 0; url; redirects += 1) {
      const response = await fetch(url.href, { redirect: 'manual', credentials: 'omit', signal })
      if (!REDIRECT_STATUSES.has(response.status)) {
        const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? ''
        if (!response.ok || !isKnownRasterImageMimeType(mimeType)) {
          await discardBody(response)
          return null
        }
        const bytes = await readCappedBody(response, maxBytes)
        return bytes ? { mimeType: mimeType.toLowerCase(), bytes } : null
      }
      const location = response.headers.get('location')
      await discardBody(response)
      url =
        location && redirects < REPO_ICON_FETCH_MAX_REDIRECTS
          ? allowed(httpsUrl(location, url))
          : null
    }
    return null
  } catch {
    return null
  }
}
