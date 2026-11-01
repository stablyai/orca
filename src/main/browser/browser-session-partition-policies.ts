import { session } from 'electron'
import type { Session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { browserManager } from './browser-manager'
import { clearProxySessionCredentials } from '../network/proxy-settings'
import {
  applyProxyToBrowserSession,
  invalidateBrowserSessionProxyApplication
} from './browser-session-proxy'
import { hasSystemMediaAccess, requestSystemMediaAccess } from './browser-media-access'
import { isAutoGrantedBrowserSessionPermission } from './browser-session-permission-policy'
import {
  answerBrowserLocalNetworkCheck,
  browserSitePermissionRequestingOrigin,
  browserSitePermissionsFor,
  decideBrowserSitePermissions,
  isBrowserSitePermissionAllowed,
  savedBrowserSitePermissions,
  sessionBrowserSitePermissions
} from './browser-site-permission-prompt'
import { installBrowserSessionUserAgentPolicy } from './browser-session-ua'
import { getBrowserProcessUserAgentIdentity } from './browser-process-user-agent'
import {
  allowsBrowserWebAuthnPermission,
  clearBrowserWebAuthnAccessHandlers,
  installBrowserWebAuthnAccessHandlers
} from './browser-webauthn-access'
import { noticeDocPreviewDownloadBlocked } from './doc-preview-download-block-notice'
import { isRemoteCliDrivenGuest } from './desktop-browser-bridge/remote-cli-driven-workspaces'

const configuredPartitions = new Set<string>()
const userAgentPolicyDisposerBySession = new WeakMap<Session, () => void>()

export function retireBrowserSessionUserAgentPolicy(sess: Session): void {
  const dispose = userAgentPolicyDisposerBySession.get(sess)
  if (!dispose) {
    return
  }
  userAgentPolicyDisposerBySession.delete(sess)
  dispose()
}

function configureBrowserSessionUserAgentPolicy(sess: Session, installExceptions: boolean): void {
  sess.setUserAgent(getBrowserProcessUserAgentIdentity().userAgent)
  if (!installExceptions) {
    retireBrowserSessionUserAgentPolicy(sess)
    return
  }
  if (userAgentPolicyDisposerBySession.has(sess)) {
    return
  }
  userAgentPolicyDisposerBySession.set(
    sess,
    installBrowserSessionUserAgentPolicy(sess, (request) =>
      browserManager.resolveBrowserGuestRequestUserAgent(request)
    )
  )
}

// SSH-driven pages must not read the desktop clipboard.
function deniesRemoteCliDrivenClipboardRead(permission: string, webContentsId?: number): boolean {
  return permission === 'clipboard-read' && isRemoteCliDrivenGuest(webContentsId)
}

/** Drop only the installer memo; retired-session guards remain fail-closed. */
export function forgetBrowserSessionPartitionConfiguration(partition: string): void {
  configuredPartitions.delete(partition)
}
const handleWillDownload = (
  event: Electron.Event,
  item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void => {
  // Prevent SSH-driven pages from writing host-chosen files into desktop Downloads.
  if (isRemoteCliDrivenGuest(webContents.id)) {
    event.preventDefault()
    console.info('[desktop-browser-bridge] refused a download from a page an SSH host drives')
    return
  }
  browserManager.handleGuestWillDownload({ guestWebContentsId: webContents.id, item })
}

// will-download omits the partition; attach each partition's selected policy to its session.
const handleDeniedWillDownload = (
  event: Electron.Event,
  _item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void => {
  event.preventDefault()
  noticeDocPreviewDownloadBlocked(webContents)
}

type RestrictedFileSystemAccessListener = (
  event: Electron.Event,
  details: Electron.FileSystemAccessRestrictedDetails,
  callback: (action: 'allow' | 'deny' | 'tryAgain') => void
) => void

// Chromium waits for an answer on blocklisted system folders; without one the page hangs.
const denyRestrictedFileSystemAccess: RestrictedFileSystemAccessListener = (
  _event,
  _details,
  callback
) => callback('deny')

const handleRestrictedFileSystemAccess: RestrictedFileSystemAccessListener = (
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

export type BrowserPartitionDownloadPolicy = 'route' | 'deny'
export type BrowserPartitionPermissionPolicy = 'browser' | 'deny'

// Keep async so initialization errors reach callers through the returned promise.
export async function installBrowserSessionPartitionPolicies(
  profile: BrowserSessionProfile,
  options: {
    downloads?: BrowserPartitionDownloadPolicy
    permissions?: BrowserPartitionPermissionPolicy
    applyAppWideProxy?: boolean
    /** Off where another machine can script pages and reuse their stored file handles. */
    fileSystemAccess?: boolean
    userAgentExceptions?: boolean
    /** Session-only answers are not persisted to a browser profile. */
    sitePermissions?: 'saved' | 'session'
  } = {}
): Promise<void> {
  const { partition } = profile
  const sess = session.fromPartition(partition)
  configureBrowserSessionUserAgentPolicy(sess, options.userAgentExceptions !== false)
  // Route partitions own a SOCKS policy that the app proxy must not overwrite.
  const proxyReady = (
    options.applyAppWideProxy === false ? Promise.resolve() : applyProxyToBrowserSession(sess)
  ).catch((error: unknown) => {
    clearProxySessionCredentials(sess)
    throw error
  })
  if (configuredPartitions.has(partition)) {
    return proxyReady
  }

  browserManager.installCertificateRequestGuard(sess)
  if (options?.permissions === 'deny') {
    sess.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    sess.setPermissionCheckHandler(() => false)
    clearBrowserWebAuthnAccessHandlers(sess)
  } else {
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
      void decide().then(callback, (error: unknown) => {
        console.error('[permissions] Browser site permission failed:', error)
        callback(false)
      })
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
        return (
          isBrowserSitePermissionAllowed({
            source,
            memory: siteMemory,
            permissions: sitePermissions
          }) &&
          (permission !== 'media' || hasSystemMediaAccess(details?.mediaType))
        )
      }
      return isAutoGranted(permission)
    })
    installBrowserWebAuthnAccessHandlers(sess)
  }
  sess.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ video: undefined, audio: undefined })
  })
  sess.removeListener('will-download', handleWillDownload)
  sess.removeListener('will-download', handleDeniedWillDownload)
  sess.on(
    'will-download',
    options?.downloads === 'deny' ? handleDeniedWillDownload : handleWillDownload
  )
  sess.removeListener('file-system-access-restricted', denyRestrictedFileSystemAccess)
  sess.removeListener('file-system-access-restricted', handleRestrictedFileSystemAccess)
  sess.on(
    'file-system-access-restricted',
    options?.permissions === 'deny'
      ? denyRestrictedFileSystemAccess
      : handleRestrictedFileSystemAccess
  )
  configuredPartitions.add(partition)
  return proxyReady
}

export function clearBrowserSessionPartitionPolicies(partition: string, sess: Session): void {
  // Electron Sessions outlive removed partitions; release their callbacks and listeners.
  invalidateBrowserSessionProxyApplication(sess)
  retireBrowserSessionUserAgentPolicy(sess)
  configuredPartitions.delete(partition)
  browserManager.removeCertificateRequestGuard(sess)
  sess.removeListener('will-download', handleWillDownload)
  sess.removeListener('will-download', handleDeniedWillDownload)
  sess.removeListener('file-system-access-restricted', denyRestrictedFileSystemAccess)
  sess.removeListener('file-system-access-restricted', handleRestrictedFileSystemAccess)
  clearBrowserWebAuthnAccessHandlers(sess)
  sess.setPermissionRequestHandler(null)
  sess.setPermissionCheckHandler(null)
  sess.setDisplayMediaRequestHandler(null)
}
