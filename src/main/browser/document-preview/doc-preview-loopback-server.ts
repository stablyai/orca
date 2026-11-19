import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { shell } from 'electron'
import {
  buildDocPreviewUrl,
  DOC_PREVIEW_SCHEME,
  isDocPreviewGrantId
} from '../../../shared/document-preview/doc-preview-scheme'
import { getDocPreviewGrant, onDocPreviewGrantRevoked } from './doc-preview-grant-registry'
import { handleDocPreviewRequest } from './doc-preview-protocol'

/** Grants the reader chose to open in the system browser; every other grant stays webview-only. */
const browserServedGrantIds = new Set<string>()
let serverPort: Promise<number> | null = null
let stopListeningForRevocations: (() => void) | null = null

// Why: browsers fetch media in ranges, and every range would otherwise re-read the whole file from the host.
const RECENT_BODY_LIMIT = 8
const RECENT_BODY_TTL_MS = 30_000
const recentBodies = new Map<
  string,
  { at: number; status: number; headers: Headers; body: Buffer }
>()

function rememberBody(
  key: string,
  entry: { status: number; headers: Headers; body: Buffer }
): void {
  recentBodies.delete(key)
  recentBodies.set(key, { ...entry, at: Date.now() })
  while (recentBodies.size > RECENT_BODY_LIMIT) {
    const oldest = recentBodies.keys().next()
    if (oldest.done) {
      break
    }
    recentBodies.delete(oldest.value)
  }
}

function recentBody(key: string): { status: number; headers: Headers; body: Buffer } | null {
  const entry = recentBodies.get(key)
  if (!entry || Date.now() - entry.at > RECENT_BODY_TTL_MS) {
    recentBodies.delete(key)
    return null
  }
  return entry
}

function sendText(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/** `bytes=a-b` within the body, or null to send it whole. */
export function parseByteRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!match || (match[1] === '' && match[2] === '') || size === 0) {
    return null
  }
  if (match[1] === '') {
    const suffix = Math.min(Number(match[2]), size)
    return suffix > 0 ? { start: size - suffix, end: size - 1 } : null
  }
  const start = Number(match[1])
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  return start <= end && start < size ? { start, end } : null
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  port: number
): Promise<void> {
  // Why: a rebinding DNS name resolving here must not reach grants through the reader's browser.
  if (request.headers.host !== `127.0.0.1:${port}`) {
    sendText(response, 403, 'Forbidden')
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed')
    return
  }
  const rawPath = (request.url ?? '/').split(/[?#]/)[0]
  const separator = rawPath.indexOf('/', 1)
  const grantId = separator === -1 ? rawPath.slice(1) : rawPath.slice(1, separator)
  if (!isDocPreviewGrantId(grantId) || !browserServedGrantIds.has(grantId)) {
    sendText(response, 404, 'Not found')
    return
  }
  const rest = separator === -1 ? '' : rawPath.slice(separator + 1)
  const key = `${grantId}/${rest}`
  let entry = recentBody(key)
  if (!entry) {
    // Same reader, authorization and failure notices as the in-app preview.
    const served = await handleDocPreviewRequest(
      new Request(`${DOC_PREVIEW_SCHEME}://${grantId}/${rest}`)
    )
    entry = {
      status: served.status,
      headers: served.headers,
      body: Buffer.from(await served.arrayBuffer())
    }
    if (entry.status === 200) {
      rememberBody(key, entry)
    }
  }
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  }
  entry.headers.forEach((value, name) => {
    headers[name] = value
  })
  const range =
    entry.status === 200 ? parseByteRange(request.headers.range, entry.body.length) : null
  if (entry.status === 200) {
    headers['Accept-Ranges'] = 'bytes'
  }
  const body = range ? entry.body.subarray(range.start, range.end + 1) : entry.body
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${entry.body.length}`
  }
  headers['Content-Length'] = String(body.length)
  response.writeHead(range ? 206 : entry.status, headers)
  response.end(request.method === 'HEAD' ? undefined : body)
}

function ensureServer(): Promise<number> {
  serverPort ??= new Promise<number>((resolve, reject) => {
    let port = 0
    const server: Server = createServer((request, response) => {
      serveRequest(request, response, port).catch(() => {
        if (!response.headersSent) {
          sendText(response, 500, 'Preview failed')
        } else {
          response.destroy()
        }
      })
    })
    server.once('error', (error) => {
      serverPort = null
      reject(error)
    })
    // Loopback only: the page is for this machine's browser, never the network.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      port = typeof address === 'object' && address ? address.port : 0
      server.unref()
      resolve(port)
    })
  })
  stopListeningForRevocations ??= onDocPreviewGrantRevoked((grant) => {
    browserServedGrantIds.delete(grant.id)
    for (const key of recentBodies.keys()) {
      if (key.startsWith(`${grant.id}/`)) {
        recentBodies.delete(key)
      }
    }
  })
  return serverPort
}

/** Serves a live grant to this machine's default browser for as long as its preview stays open. */
export async function openDocPreviewInSystemBrowser(grantId: string): Promise<boolean> {
  const grant = getDocPreviewGrant(grantId)
  if (!grant) {
    return false
  }
  const port = await ensureServer()
  browserServedGrantIds.add(grant.id)
  const previewUrl = buildDocPreviewUrl(grant.id, grant.entryRelativePath)
  const path = previewUrl.slice(`${DOC_PREVIEW_SCHEME}://`.length)
  await shell.openExternal(`http://127.0.0.1:${port}/${path}`)
  return true
}
