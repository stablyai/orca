import { protectBrowserGuestMedia } from '../../guest-lifecycle/manager/registration/browser-guest-discard-protection'
import { isRemoteCliDrivenGuest } from '../../desktop-browser-bridge/remote-cli-driven-workspaces'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import type { Session } from 'electron'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'
import { hasSystemMediaAccess, requestSystemMediaAccess } from './browser-media-access'
import {
  isAutoGrantedBrowserSessionPermission,
  browserSitePermissionsFor
} from './browser-session-permission-policy'
import {
  answerBrowserLocalNetworkCheck,
  browserSitePermissionRequestingOrigin,
  decideBrowserSitePermissions,
  isBrowserSitePermissionAllowed
} from './browser-site-permission-prompt'
import {
  savedBrowserSitePermissions,
  sessionBrowserSitePermissions
} from './browser-site-permission-memory'
import {
  allowsBrowserWebAuthnPermission,
  installBrowserWebAuthnAccessHandlers
} from '../../webauthn/browser-webauthn-access'

// SSH-driven pages must not read the desktop clipboard.
function deniesRemoteCliDrivenClipboardRead(permission: string, webContentsId?: number): boolean {
  return permission === 'clipboard-read' && isRemoteCliDrivenGuest(webContentsId)
}

type RestrictedFileSystemAccessListener = (
  event: Electron.Event,
  details: Electron.FileSystemAccessRestrictedDetails,
  callback: (action: 'allow' | 'deny' | 'tryAgain') => void
) => void

// Chromium waits for an answer on blocklisted system folders; without one the page hangs.
export const denyRestrictedFileSystemAccess: RestrictedFileSystemAccessListener = (
  _event,
  _details,
  callback
) => callback('deny')

export const handleRestrictedFileSystemAccess: RestrictedFileSystemAccessListener = (
  _event,
  details,
  callback
) => {
  callback('deny')
  if (details.webContents) {
    browserManager.notifyPermissionDenied({
      guestWebContentsId: details.webContents.id,
      permission: 'fileSystem',
      rawUrl: details.origin
    })
  }
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

export type BrowserSessionPermissionOptions = {
  /** Off where another machine can script pages and reuse their stored file handles. */
  fileSystemAccess?: boolean
  /** Session-only answers are not persisted to a browser profile. */
  sitePermissions?: 'saved' | 'session'
}

export function installBrowserSessionPermissionHandlers(
  sess: Session,
  profile: BrowserSessionProfile,
  options: BrowserSessionPermissionOptions
): void {
  const { partition } = profile
  // Electron answers every File System Access grant here, overriding Chromium's own;
  // the user's pick or drop is the consent, and handles a site stores keep their access.
  const grantsFileSystem = options.fileSystemAccess !== false
  const isAutoGranted = (permission: string): boolean =>
    isAutoGrantedBrowserSessionPermission(permission) ||
    (grantsFileSystem && permission === 'fileSystem')
  const siteMemory =
    options.sitePermissions === 'session'
      ? sessionBrowserSitePermissions(partition)
      : savedBrowserSitePermissions(profile.id)
  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (
      permission === 'openExternal' &&
      browserManager.requestExternalAppLaunch(
        webContents,
        'externalURL' in details ? details.externalURL : undefined,
        () => resolvePermissionNoticeUrl(webContents, details) || null
      )
    ) {
      // Orca launches approved apps itself; deny Chromium's duplicate launch.
      callback(false)
      return
    }
    // Capture the requesting URL before async handling; opaque frames have no named site.
    const rawUrl = resolvePermissionNoticeUrl(webContents, details)
    const notifyDenied = (): void =>
      browserManager.notifyPermissionDenied({
        guestWebContentsId: webContents.id,
        permission,
        rawUrl
      })
    if (deniesRemoteCliDrivenClipboardRead(permission, webContents.id)) {
      notifyDenied()
      callback(false)
      return
    }
    const mediaRequest = 'mediaTypes' in details ? details : undefined
    const sitePermissions = browserSitePermissionsFor(permission, mediaRequest?.mediaTypes)
    if (!sitePermissions) {
      const allowed = isAutoGranted(permission)
      if (!allowed) {
        notifyDenied()
      }
      callback(allowed)
      return
    }
    const decide = async (): Promise<boolean> => {
      const allowed = await decideBrowserSitePermissions({
        requester: webContents,
        frameOrigin: sitePermissions.includes('notifications')
          ? browserSitePermissionRequestingOrigin(webContents, details)
          : null,
        memory: siteMemory,
        permissions: sitePermissions
      })
      if (!allowed || permission !== 'media') {
        return allowed
      }
      // macOS also gates camera and mic per app; distinguish OS refusal from a site decision.
      const granted = await requestSystemMediaAccess(mediaRequest)
      if (!granted) {
        notifyDenied()
      }
      return granted
    }
    void decide().then(
      (allowed) => {
        if (allowed && permission === 'media') {
          protectBrowserGuestMedia(webContents)
        }
        callback(allowed)
      },
      (error: unknown) => {
        console.error('[permissions] Browser site permission failed:', error)
        callback(false)
      }
    )
  })
  sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (deniesRemoteCliDrivenClipboardRead(permission, webContents?.id)) {
      return false
    }
    if (allowsBrowserWebAuthnPermission(permission, details)) {
      return true
    }
    const sitePermissions = browserSitePermissionsFor(
      permission,
      details?.mediaType ? [details.mediaType] : undefined
    )
    if (sitePermissions) {
      const source = {
        // Service-worker checks have no WebContents; use their requesting origin.
        pageUrl: webContents?.getURL() ?? requestingOrigin,
        // Checks supply the frame's inherited origin.
        frameOrigin: requestingOrigin
      }
      if (sitePermissions.includes('local-network')) {
        return answerBrowserLocalNetworkCheck({
          requester: webContents,
          source,
          memory: siteMemory
        })
      }
      const allowed =
        isBrowserSitePermissionAllowed({
          source,
          memory: siteMemory,
          permissions: sitePermissions
        }) &&
        (permission !== 'media' || hasSystemMediaAccess(details?.mediaType))
      if (allowed && permission === 'media' && webContents) {
        protectBrowserGuestMedia(webContents)
      }
      return allowed
    }
    return isAutoGranted(permission)
  })
  installBrowserWebAuthnAccessHandlers(sess)
}
