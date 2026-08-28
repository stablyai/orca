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

// Why: one shared installer keeps every partition's deny-by-default permission/download policies from drifting apart.
const configuredPartitions = new Set<string>()
const handleWillDownload = (
  _event: Electron.Event,
  item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void => {
  browserManager.handleGuestWillDownload({ guestWebContentsId: webContents.id, item })
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

export function installBrowserSessionPartitionPolicies(profile: BrowserSessionProfile): void {
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
  sess.on('will-download', handleWillDownload)
  configuredPartitions.add(partition)
}

export function clearBrowserSessionPartitionPolicies(partition: string, sess: Session): void {
  // Why: the Electron Session survives partition deletion; clear callbacks/listeners so removed profiles don't retain closures.
  configuredPartitions.delete(partition)
  browserManager.removeCertificateRequestGuard(sess)
  sess.removeListener('will-download', handleWillDownload)
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
