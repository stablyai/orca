import { session, type Session } from 'electron'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { clearProxySessionCredentials } from '../../../network/proxy-settings'
import {
  applyProxyToBrowserSession,
  invalidateBrowserSessionProxyApplication
} from '../proxy/browser-session-proxy'
import { installBrowserSessionUserAgentPolicy } from '../../identity/requests/browser-session-ua'
import { getBrowserProcessUserAgentIdentity } from '../../identity/browser-process-user-agent'
import { clearBrowserWebAuthnAccessHandlers } from '../../webauthn/browser-webauthn-access'
import {
  handleWillDownload,
  handleDeniedWillDownload,
  type BrowserPartitionDownloadPolicy
} from '../../downloads/browser-session-download-policy'
import {
  denyRestrictedFileSystemAccess,
  handleRestrictedFileSystemAccess,
  installBrowserSessionPermissionHandlers,
  type BrowserSessionPermissionOptions
} from '../../site-settings/permissions/browser-session-permission-handlers'

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

/** Drop only the installer memo; retired-session guards remain fail-closed. */
export function forgetBrowserSessionPartitionConfiguration(partition: string): void {
  configuredPartitions.delete(partition)
}
export type BrowserPartitionPermissionPolicy = 'browser' | 'deny'

// Keep async so initialization errors reach callers through the returned promise.
export async function installBrowserSessionPartitionPolicies(
  profile: BrowserSessionProfile,
  options: BrowserSessionPermissionOptions & {
    downloads?: BrowserPartitionDownloadPolicy
    permissions?: BrowserPartitionPermissionPolicy
    applyAppWideProxy?: boolean
    userAgentExceptions?: boolean
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
    installBrowserSessionPermissionHandlers(sess, profile, options)
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
