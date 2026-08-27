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

/** Must run before `app.whenReady()`; Electron freezes the privileged scheme table at ready. */
export function registerDocPreviewSchemePrivileges(): void {
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
    }
  ])
}

let docPreviewSession: Electron.Session | null = null

/** Non-persistent session, so preview bytes never land in a browsing profile's storage. */
export function getDocPreviewSession(): Electron.Session {
  docPreviewSession ??= session.fromPartition(DOC_PREVIEW_PARTITION)
  return docPreviewSession
}

/** Pure identity check: every guest attach consults it, and none should materialize a session. */
export function isDocPreviewSession(candidate: Electron.Session): boolean {
  return docPreviewSession !== null && candidate === docPreviewSession
}

/**
 * Product decision, not a hardening default: previewed documents are agent-authored, so any
 * outbound request they can make is an exfiltration channel for whatever else the page can read.
 * Self-contained documents — inline CSS/JS/SVG and in-grant assets — render in full; a CDN
 * stylesheet, font, script, or analytics beacon deliberately does not load.
 */
const DOC_PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'"
  // Why no `webrtc 'block'` here, though a peer connection is exactly the outbound channel this
  // policy is meant to close: Chromium 43-era answers that directive with "Unrecognized
  // Content-Security-Policy directive 'webrtc'" and gathers candidates anyway, so listing it would
  // read as a fence while fencing nothing. The guest's IP-handling policy is the one that holds —
  // see `installDocPreviewGuestPolicy`.
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
    // Why: a revoked or unknown grant is indistinguishable from a missing file by design — but the
    // shell still needs to know, or the guest paints this body where the document should be.
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
  return new Response(new Uint8Array(outcome.bytes), {
    status: 200,
    headers: {
      'Content-Type': outcome.contentType,
      'Content-Security-Policy': DOC_PREVIEW_CONTENT_SECURITY_POLICY,
      // Why: reload must re-read the workspace disk, so nothing may be cached.
      'Cache-Control': 'no-store'
    }
  })
}

/** `data:`/`blob:` never leave the document; every other scheme would reach off-machine. */
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
  // Why: the response CSP is the document's own promise to obey; this is the session refusing to
  // carry the request at all, so a CSP bypass in one element type still reaches nothing.
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedDocPreviewRequestUrl(details.url) })
  })
  // Why: preview guests are webviews like any other, so they inherit the same deny-by-default
  // permission, display-media and user-agent policy every browser partition gets.
  installBrowserSessionPartitionPolicies(
    {
      id: DOC_PREVIEW_PARTITION,
      scope: 'isolated',
      partition: DOC_PREVIEW_PARTITION,
      label: 'Document preview',
      source: null,
      userAgentMode: 'clean'
    },
    // Why downloads are the one policy that does not carry over: the browser download flow needs a
    // page to attribute the file to, and a previewed document is not one. Routed here it would
    // reserve a name in this desktop's Downloads folder and write remote-authored bytes into it
    // with nothing in the UI naming the tab that asked, and no prompt in front of it.
    { downloads: 'deny' }
  )
}
