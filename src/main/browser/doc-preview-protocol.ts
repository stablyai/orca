import { protocol, session } from 'electron'
import {
  DOC_PREVIEW_PARTITION,
  DOC_PREVIEW_SCHEME,
  parseDocPreviewUrl
} from '../../shared/doc-preview-scheme'
import { installBrowserSessionPartitionPolicies } from './browser-session-partition-policies'
import { readDocPreviewFile } from './doc-preview-file-reader'
import { publishDocPreviewFailure } from './doc-preview-failure-notice'
import { getDocPreviewGrant } from './doc-preview-grant-registry'

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

export async function handleDocPreviewRequest(request: Request): Promise<Response> {
  const target = parseDocPreviewUrl(request.url)
  if (!target) {
    return notFound('Not found')
  }
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
  const outcome = await readDocPreviewFile(grant, relativePath)
  if (!outcome.ok) {
    publishDocPreviewFailure({ grantId: target.grantId, relativePath, reason: outcome.reason })
    return new Response(outcome.message, {
      status: outcome.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
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
  previewSession.protocol.handle(DOC_PREVIEW_SCHEME, handleDocPreviewRequest)
  // Block network requests beyond CSP; explicit DNS-prefetch bypasses this hook.
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedDocPreviewRequestUrl(details.url) })
  })
  installBrowserSessionPartitionPolicies(
    {
      id: DOC_PREVIEW_PARTITION,
      scope: 'isolated',
      partition: DOC_PREVIEW_PARTITION,
      label: 'Document preview',
      source: null
    },
    // Previews have no browsing-page download flow or ambient device permissions.
    { downloads: 'deny', permissions: 'deny' }
  )
}
