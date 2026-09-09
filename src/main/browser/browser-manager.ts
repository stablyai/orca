import { webContents } from 'electron'
import { BrowserCertificateTrustController } from './browser-certificate-trust-controller'
import { BrowserManagerFinal } from './browser-manager-final'

export type { BrowserGuestPolicy, BrowserGuestRegistration } from './browser-manager-types'

/**
 * Privileged browser guest facade. Behavior is organized by lifecycle concern in the focused
 * manager modules while this module keeps the stable import surface used by main and renderer code.
 */
export class BrowserManager extends BrowserManagerFinal {}

export const browserManager = new BrowserManager()
export const browserCertificateTrustController = new BrowserCertificateTrustController({
  resolveManagedGuestContext: (webContentsId) =>
    browserManager.getManagedBrowserGuestContext(webContentsId),
  resolveWebContentsIdForPage: (browserPageId) =>
    browserManager.getGuestWebContentsId(browserPageId),
  resolveWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  onFailureChanged: (webContentsId, failure, navigationUrl) =>
    browserManager.notifyCertificateFailureChanged(webContentsId, failure, navigationUrl)
})
browserManager.setCertificateTrustController(browserCertificateTrustController)
