import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { guardedLookup, linkPreviewTarget } from './link-preview-address-guard'

const MAX_REDIRECTS = 4
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const USER_AGENT =
  'Mozilla/5.0 (compatible; OrcaLinkPreview/1.0; +https://github.com/stablyai/orca)'

export type LinkPreviewResource = {
  /** The URL that answered, after redirects. */
  url: URL
  mimeType: string
  contentType: string
  body: Buffer
}

export type LinkPreviewResourceRequest = {
  /** A page keeps what it read up to the cap or `</head>`; an image over the cap is dropped. */
  kind: 'page' | 'image'
  mimeTypes: ReadonlySet<string>
  maxBytes: number
  signal: AbortSignal
  lookup?: LookupFunction
}

type Hop =
  | { kind: 'redirect'; location: string }
  | { kind: 'resource'; resource: LinkPreviewResource }

/** GET without cookies or proxy (the guard must see the real peer), re-guarding every redirect hop. */
export async function fetchLinkPreviewResource(
  target: string,
  request: LinkPreviewResourceRequest
): Promise<LinkPreviewResource | null> {
  let url = linkPreviewTarget(target)
  for (let redirects = 0; url; redirects++) {
    const hop = await requestOnce(url, request)
    if (hop?.kind !== 'redirect') {
      return hop?.resource ?? null
    }
    url = redirects < MAX_REDIRECTS ? linkPreviewTarget(hop.location, url) : null
  }
  return null
}

function requestOnce(url: URL, request: LinkPreviewResourceRequest): Promise<Hop | null> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (hop: Hop | null): void => {
      if (!settled) {
        settled = true
        resolve(hop)
      }
    }
    const client = url.protocol === 'https:' ? https : http
    const outgoing = client.get(
      url,
      {
        agent: false,
        lookup: request.lookup ?? guardedLookup,
        signal: request.signal,
        headers: {
          accept: request.kind === 'page' ? 'text/html' : 'image/*',
          'user-agent': USER_AGENT
        }
      },
      (response) => {
        const status = response.statusCode ?? 0
        const contentType = response.headers['content-type'] ?? ''
        const mimeType = contentType.split(';')[0].trim().toLowerCase()
        const declaredBytes = Number(response.headers['content-length'])
        const location = response.headers.location
        if (REDIRECT_STATUSES.has(status) || status < 200 || status >= 300) {
          response.destroy()
          settle(REDIRECT_STATUSES.has(status) && location ? { kind: 'redirect', location } : null)
          return
        }
        if (
          !request.mimeTypes.has(mimeType) ||
          (request.kind === 'image' && declaredBytes > request.maxBytes)
        ) {
          response.destroy()
          settle(null)
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        let headTail = ''
        const finish = (): void => {
          response.destroy()
          settle({
            kind: 'resource',
            resource: { url, mimeType, contentType, body: Buffer.concat(chunks) }
          })
        }
        response.on('data', (chunk: Buffer) => {
          if (settled) {
            return
          }
          size += chunk.length
          if (size > request.maxBytes) {
            if (request.kind === 'image') {
              response.destroy()
              settle(null)
              return
            }
            chunks.push(chunk.subarray(0, chunk.length - (size - request.maxBytes)))
            finish()
            return
          }
          chunks.push(chunk)
          if (request.kind === 'page') {
            // Only the new chunk plus a short carry is searched, so the scan stays linear.
            const window = headTail + chunk.toString('latin1')
            if (/<\/head\s*>/i.test(window)) {
              finish()
              return
            }
            headTail = window.slice(-8)
          }
        })
        response.on('end', finish)
        response.on('error', () => settle(null))
        response.on('close', () => settle(null))
      }
    )
    outgoing.on('error', () => settle(null))
  })
}
