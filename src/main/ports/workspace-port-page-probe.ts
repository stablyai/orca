import http from 'node:http'
import https from 'node:https'
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
      title: extractHtmlTitle(html),
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

function extractHtmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = match ? decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim() : ''
  return title ? title.slice(0, 120) : null
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity
    }
    return named[body.toLowerCase()] ?? entity
  })
}

function findIconHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = new Map<string, string>()
    for (const [, name, double, single, bare] of tag.matchAll(
      /\b(rel|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
    )) {
      attributes.set(name.toLowerCase(), double ?? single ?? bare ?? '')
    }
    const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? []
    const href = attributes.get('href')
    if (rel.includes('icon') && href) {
      return decodeHtmlEntities(href)
    }
  }
  return null
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
