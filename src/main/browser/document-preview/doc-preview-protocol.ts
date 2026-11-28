import { protocol, session } from 'electron'
import {
  DOC_PREVIEW_PARTITION,
  DOC_PREVIEW_SCHEME,
  parseDocPreviewUrl
} from '../../../shared/document-preview/doc-preview-scheme'
import { installBrowserSessionPartitionPolicies } from '../sessions/partition-policies/browser-session-partition-policies'
import { holdBrowserSessionWebRequest } from '../sessions/requests/browser-session-web-request-owner'
import { MAX_FILE_RANGE_READ_BYTES } from '../../../shared/file-content/file-range-read'

/** Register before Electron readiness freezes scheme privileges. */
export function registerDocPreviewSchemePrivileges(
  additionalSchemes: Electron.CustomScheme[] = []
): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DOC_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    },
    ...additionalSchemes
  ])
}

let docPreviewSession: Electron.Session | null = null

/** Isolate previews from persistent browsing-profile storage. */
export function getDocPreviewSession(): Electron.Session {
  docPreviewSession ??= session.fromPartition(DOC_PREVIEW_PARTITION)
  return docPreviewSession
}

/** Guest identity checks must not materialize a session. */
export function isDocPreviewSession(candidate: Electron.Session): boolean {
  return docPreviewSession !== null && candidate === docPreviewSession
}

// Block outbound requests that could exfiltrate grant-readable files.
// Electron 43 DNS-prefetch bypasses these request hooks.
const DOC_PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'"
  // Electron 43 ignores WebRTC CSP; installDocPreviewGuestPolicy enforces IP handling.
].join('; ')

function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
}

/** The bytes a media response sends first; one byte when only the file's size can tell (HEAD, suffix ranges). */
function firstMediaRead(request: Request): { offset: number; length: number } {
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') ?? 'bytes=0-')
  const start = Number(match?.[1])
  const end = match?.[2] ? Number(match[2]) : Number.MAX_SAFE_INTEGER
  if (request.method === 'HEAD' || !Number.isSafeInteger(start) || end < start) {
    return { offset: 0, length: 1 }
  }
  return { offset: start, length: Math.min(MAX_FILE_RANGE_READ_BYTES, end - start + 1) }
}

export async function handleDocPreviewRequest(request: Request): Promise<Response> {
  const target = parseDocPreviewUrl(request.url)
  if (!target) {
    return notFound('Not found')
  }
  const [{ getDocPreviewGrant }, { publishDocPreviewFailure }, { readDocPreviewFile }] =
    await Promise.all([
      import('./doc-preview-grant-registry'),
      import('./doc-preview-failure-notice'),
      import('./doc-preview-file-reader')
    ])
  const grant = getDocPreviewGrant(target.grantId)
  if (!grant) {
    // Keep missing and revoked grants indistinguishable; tell the shell to replace the error body.
    publishDocPreviewFailure({
      grantId: target.grantId,
      relativePath: target.relativePath,
      reason: 'unreadable'
    })
    return notFound('Not found')
  }
  const relativePath = target.relativePath || grant.entryRelativePath
  const outcome = await readDocPreviewFile(grant, relativePath, {
    firstRead: firstMediaRead(request),
    signal: request.signal
  })
  if (!outcome.ok) {
    // A cancelled media request (a seek, a new source) is not a file the page failed to load.
    if (!request.signal.aborted) {
      publishDocPreviewFailure({ grantId: target.grantId, relativePath, reason: outcome.reason })
    }
    return new Response(outcome.message, {
      status: outcome.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }
  if ('media' in outcome) {
    // Media streams by range, so seeking works and a long video never sits in memory.
    const { createMediaRangeResponse } = await import('../../media/media-range-response')
    return createMediaRangeResponse(request, outcome.contentType, outcome.media)
  }
  const bytes = outcome.bytes
  const body =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes)
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': outcome.contentType,
      'Content-Security-Policy': DOC_PREVIEW_CONTENT_SECURITY_POLICY,
      // Reload must re-read workspace files.
      'Cache-Control': 'no-store'
    }
  })
}

export function isAllowedDocPreviewRequestUrl(url: string): boolean {
  return (
    url.startsWith(`${DOC_PREVIEW_SCHEME}://`) ||
    url.startsWith('devtools://') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  )
}

export function installDocPreviewProtocolHandler(): void {
  const previewSession = getDocPreviewSession()
  if (previewSession.protocol.isProtocolHandled(DOC_PREVIEW_SCHEME)) {
    return
  }
  // Block network requests beyond CSP; explicit DNS-prefetch bypasses this hook.
  // Why first: if the block can't be held, previews never get their scheme and stay closed.
  holdBrowserSessionWebRequest(previewSession, 'onBeforeRequest', (details, callback) => {
    callback({ cancel: !isAllowedDocPreviewRequestUrl(details.url) })
  })
  previewSession.protocol.handle(DOC_PREVIEW_SCHEME, handleDocPreviewRequest)
  installBrowserSessionPartitionPolicies(
    {
      id: DOC_PREVIEW_PARTITION,
      scope: 'isolated',
      partition: DOC_PREVIEW_PARTITION,
      label: 'Document preview',
      source: null
    },
    // Previews have no browsing-page download flow or ambient device permissions. The block above
    // already cancels all network, and the certificate guard would replace it as onBeforeRequest.
    { downloads: 'deny', permissions: 'deny', certificateRequestGuard: false }
  )
}
