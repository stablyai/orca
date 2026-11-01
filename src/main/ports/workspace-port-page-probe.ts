import http from 'node:http'
import https from 'node:https'
import { extractHtmlTitle, findIconHref } from '../html-head-tags'
import {
  LOOPBACK_LOCALHOST_HOSTS,
  connectableLoopbackHost,
  normalizeLocalhostHostname
} from '../../shared/localhost-worktree-labels'
import type {
  WorkspacePortPageProbeRequest,
  WorkspacePortPageProbeResult
} from '../../shared/workspace-ports'

const PROBE_TIMEOUT_MS = 1500
const MAX_PAGE_BYTES = 256 * 1024
const MAX_FAVICON_BYTES = 64 * 1024
const MAX_REDIRECTS = 3
const NOT_PAGE: WorkspacePortPageProbeResult = { kind: 'not-page' }

type ProbeResponse = {
  status: number
  location: string | undefined
  contentType: string
  body: Buffer
}

export async function probeWorkspacePortPage(
  request: WorkspacePortPageProbeRequest
): Promise<WorkspacePortPageProbeResult> {
  const origin = loopbackOrigin(request)
  if (!origin) {
    return NOT_PAGE
  }
  let url = new URL('/', origin)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetchLoopback(url, MAX_PAGE_BYTES)
    if (!response) {
      return NOT_PAGE
    }
    if (response.status >= 300 && response.status < 400 && response.location) {
      const next = new URL(response.location, url)
      // Redirects cannot turn a listener probe into a request to another origin.
      if (next.origin !== url.origin) {
        return NOT_PAGE
      }
      url = next
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      return NOT_PAGE
    }
    if (!response.contentType.toLowerCase().includes('text/html')) {
      return NOT_PAGE
    }
    const html = response.body.toString('utf8')
    return {
      kind: 'page',
      title: extractHtmlTitle(html)?.slice(0, 120) ?? null,
      faviconDataUrl: await fetchFaviconDataUrl(html, url)
    }
  }
  return NOT_PAGE
}

function loopbackOrigin({ host, port, protocol }: WorkspacePortPageProbeRequest): string | null {
  const bare = normalizeLocalhostHostname(host)
  if (!LOOPBACK_LOCALHOST_HOSTS.has(bare) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  const connectHost = connectableLoopbackHost(bare)
  const urlHost = connectHost.includes(':') ? `[${connectHost}]` : connectHost
  return `${protocol === 'https' ? 'https' : 'http'}://${urlHost}:${port}`
}

function fetchLoopback(url: URL, maxBytes: number): Promise<ProbeResponse | null> {
  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http
    const request = client.get(
      url,
      {
        agent: false,
        headers: { accept: 'text/html,image/*;q=0.9,*/*;q=0.8' },
        // Loopback development TLS may be self-signed; return only title/icon metadata.
        rejectUnauthorized: false,
        timeout: PROBE_TIMEOUT_MS
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        const finish = (): void =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            contentType: response.headers['content-type'] ?? '',
            body: Buffer.concat(chunks)
          })
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          chunks.push(chunk)
          if (size >= maxBytes) {
            response.destroy()
            finish()
          }
        })
        response.on('end', finish)
        response.on('error', () => resolve(null))
      }
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(null))
  })
}

async function fetchFaviconDataUrl(html: string, pageUrl: URL): Promise<string | null> {
  const href = findIconHref(html) ?? '/favicon.ico'
  if (href.startsWith('data:image/')) {
    return href.length <= MAX_FAVICON_BYTES * 2 ? href : null
  }
  let iconUrl: URL
  try {
    iconUrl = new URL(href, pageUrl)
  } catch {
    return null
  }
  if (iconUrl.origin !== pageUrl.origin) {
    return null
  }
  const response = await fetchLoopback(iconUrl, MAX_FAVICON_BYTES + 1)
  if (
    !response ||
    response.status !== 200 ||
    response.body.length === 0 ||
    response.body.length > MAX_FAVICON_BYTES
  ) {
    return null
  }
  const contentType = response.contentType.split(';')[0].trim().toLowerCase()
  // SPA fallback HTML must not become an icon based only on its URL extension.
  const untyped = contentType === '' || contentType === 'application/octet-stream'
  const imageType = contentType.startsWith('image/')
    ? contentType
    : untyped && iconUrl.pathname.toLowerCase().endsWith('.ico')
      ? 'image/x-icon'
      : null
  return imageType ? `data:${imageType};base64,${response.body.toString('base64')}` : null
}
