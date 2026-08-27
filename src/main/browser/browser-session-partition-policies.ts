import { session } from 'electron'
import type { Session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { browserManager } from './browser-manager'
import { hasSystemMediaAccess, requestSystemMediaAccess } from './browser-media-access'
import { isAutoGrantedBrowserSessionPermission } from './browser-session-permission-policy'
import { cleanElectronUserAgent, setupClientHintsOverride } from './browser-session-ua'
import { setBrowserSessionUserAgentMode } from './browser-session-user-agent-mode'
import {
  allowsBrowserWebAuthnPermission,
  clearBrowserWebAuthnAccessHandlers,
  installBrowserWebAuthnAccessHandlers
} from './browser-webauthn-access'
import { noticeDocPreviewDownloadBlocked } from './doc-preview-download-block-notice'

// Why: one shared installer keeps every partition's deny-by-default permission/download policies from drifting apart.
const configuredPartitions = new Set<string>()
const handleWillDownload = (
  _event: Electron.Event,
  item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void => {
  browserManager.handleGuestWillDownload({ guestWebContentsId: webContents.id, item })
}

/**
 * Why a second listener instead of a branch inside the shared one: `will-download` is a session
 * event that names no partition, so the only place the decision can be keyed by partition is which
 * listener that partition's session got. A workspace-document guest has no page of its own to
 * attribute a download to, so routing one lands it in this desktop's Downloads folder under a
 * remote-authored name that nothing in the UI accounts for.
 */
const handleDeniedWillDownload = (
  event: Electron.Event,
  _item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void => {
  event.preventDefault()
  // The page gets nothing back; the reader gets a sentence, or a pressed button just does nothing.
  noticeDocPreviewDownloadBlocked(webContents)
}

function resolvePermissionNoticeUrl(
  webContents: Electron.WebContents,
  details: Electron.PermissionRequest | undefined
): string {
  const requestingUrl = details?.requestingUrl
  if (!requestingUrl) {
    return webContents.getURL()
  }
  try {
    return new URL(requestingUrl).origin === 'null' ? '' : requestingUrl
  } catch {
    return ''
  }
}

/** `route` hands the item to the owning page's download flow; `deny` cancels it before it starts. */
export type BrowserPartitionDownloadPolicy = 'route' | 'deny'

export function installBrowserSessionPartitionPolicies(
  profile: BrowserSessionProfile,
  options?: { downloads?: BrowserPartitionDownloadPolicy }
): void {
  const { partition } = profile
  const sess = session.fromPartition(partition)
  setBrowserSessionUserAgentMode(sess, profile.userAgentMode ?? 'clean')
  if (configuredPartitions.has(partition)) {
    return
  }

  browserManager.installCertificateRequestGuard(sess)
  if (profile.userAgentMode !== 'native' && typeof sess.getUserAgent === 'function') {
    const cleanUA = cleanElectronUserAgent(sess.getUserAgent())
    sess.setUserAgent(cleanUA)
    setupClientHintsOverride(sess, cleanUA)
  }
  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // Why: defer media to macOS TCC; denying at the session layer throws NotAllowedError even after the user granted Camera/Mic to the OS.
    if (permission === 'media') {
      // Capture before async handling; opaque frames cannot be attributed to a named site.
      const rawUrl = resolvePermissionNoticeUrl(webContents, details)
      void requestSystemMediaAccess(
        details as Electron.MediaAccessPermissionRequest | undefined
      ).then(
        (granted) => {
          if (!granted) {
            browserManager.notifyPermissionDenied({
              guestWebContentsId: webContents.id,
              permission,
              rawUrl
            })
          }
          callback(granted)
        },
        (error: unknown) => {
          console.error('[permissions] Browser media access failed:', error)
          browserManager.notifyPermissionDenied({
            guestWebContentsId: webContents.id,
            permission,
            rawUrl
          })
          callback(false)
        }
      )
      return
    }
    const allowed = isAutoGrantedBrowserSessionPermission(permission)
    if (!allowed) {
      const rawUrl = resolvePermissionNoticeUrl(webContents, details)
      browserManager.notifyPermissionDenied({
        guestWebContentsId: webContents.id,
        permission,
        rawUrl
      })
    }
    callback(allowed)
  })
  sess.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (permission === 'media') {
      return hasSystemMediaAccess(details?.mediaType)
    }
    if (allowsBrowserWebAuthnPermission(permission, details)) {
      return true
    }
    return isAutoGrantedBrowserSessionPermission(permission)
  })
  installBrowserWebAuthnAccessHandlers(sess)
  sess.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ video: undefined, audio: undefined })
  })
  sess.removeListener('will-download', handleWillDownload)
  sess.removeListener('will-download', handleDeniedWillDownload)
  sess.on(
    'will-download',
    options?.downloads === 'deny' ? handleDeniedWillDownload : handleWillDownload
  )
  configuredPartitions.add(partition)
}

export function clearBrowserSessionPartitionPolicies(partition: string, sess: Session): void {
  // Why: the Electron Session survives partition deletion; clear callbacks/listeners so removed profiles don't retain closures.
  configuredPartitions.delete(partition)
  browserManager.removeCertificateRequestGuard(sess)
  sess.removeListener('will-download', handleWillDownload)
  sess.removeListener('will-download', handleDeniedWillDownload)
  clearBrowserWebAuthnAccessHandlers(sess)
  sess.setPermissionRequestHandler(null)
  sess.setPermissionCheckHandler(null)
  sess.setDisplayMediaRequestHandler(null)
}

export function applyBrowserSessionUserAgentModes(profiles: BrowserSessionProfile[]): void {
  for (const profile of profiles) {
    const partition = profile.partition
    try {
      const sess = session.fromPartition(partition)
      const userAgentMode = profile.userAgentMode ?? 'clean'
      setBrowserSessionUserAgentMode(sess, userAgentMode)

      if (profile.userAgentMode === 'native') {
        continue
      }

      // Why: the default Electron UA leaks "Electron/X.X.X" + app name, which trips Cloudflare Turnstile.
      const cleanUA = cleanElectronUserAgent(sess.getUserAgent())
      sess.setUserAgent(cleanUA)
      setupClientHintsOverride(sess, cleanUA)
    } catch {
      /* session not available yet (e.g. unit tests or pre-ready) */
    }
  }
}
