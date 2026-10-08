import { BrowserWindow, session, View, WebContentsView } from 'electron'
import { join } from 'node:path'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
import { browserManager } from './browser-manager'
import { browserSessionRegistry } from './browser-session-registry'
import { DesktopOwnedBrowserViewAdmission } from './desktop-owned-browser-view-admission'
import { DesktopBrowserViewService } from './desktop-browser-view-service'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import { resolveTabRegistrationWaiters } from '../ipc/browser-tab-registration-wait'
import { cancelBrowserWebAuthnAccountRequests } from './browser-webauthn-account-picker'
import { disposeGrabModeStateForPage } from '../ipc/browser-grab-ipc'
import { DesktopOwnedBrowserCapture } from './desktop-owned-browser-capture'
import { captureDesktopBrowserViewViewport } from './desktop-browser-view-capture'

export function createDesktopBrowserViewService(
  getBridge: () => AgentBrowserBridge | null
): DesktopBrowserViewService {
  const capture = new DesktopOwnedBrowserCapture()
  const admission = new DesktopOwnedBrowserViewAdmission({
    isKnownPartition: (profileId) => browserSessionRegistry.resolveKnownPartition(profileId),
    getSession: (partition) => session.fromPartition(partition),
    createView: (partition) =>
      new WebContentsView({
        webPreferences: {
          ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
          partition,
          preload: join(__dirname, 'browser-window-close-preload.js'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          webviewTag: false,
          allowRunningInsecureContent: false,
          backgroundThrottling: false
        }
      }),
    attachPolicies: (guest) => browserManager.attachGuestPolicies(guest)
  })
  return new DesktopBrowserViewService({
    admission,
    manager: browserManager,
    captureViewport: captureDesktopBrowserViewViewport,
    resolveOwner: (sender) => BrowserWindow.fromWebContents(sender),
    createContainer: () => new View(),
    publish: (sender, event) => {
      if (!sender.isDestroyed()) {
        sender.send('browser:desktop-view:event', event)
      }
    },
    onRegistered: (record, controller, owner) => {
      const dispose = capture.register(controller, owner)
      resolveTabRegistrationWaiters(record.browserPageId, record.worktreeId)
      return dispose
    },
    retirePage: async (record) => {
      const bridge = getBridge()
      if (bridge) {
        await (browserManager.getGuestWebContentsId(record.browserPageId) === record.webContents.id
          ? bridge.onTabClosed(record.webContents.id)
          : bridge.onPageClosed(record.browserPageId))
      }
      cancelBrowserWebAuthnAccountRequests(record.browserPageId)
      disposeGrabModeStateForPage(record.browserPageId)
    },
    onError: (error) => console.error('[desktop-browser-view] retained lifecycle failure', error)
  })
}
