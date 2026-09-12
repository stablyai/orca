import { ipcMain, webContents } from 'electron'
import { browserCertificateTrustController, browserManager } from '../browser/browser-manager'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { isWorkspaceDocPageId } from '../browser/doc-preview-guest-policy'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import {
  isLiveBrowserWebContentsId,
  resolveTabRegistrationWaiters
} from './browser-tab-registration-wait'
import { registerBrowserGuestViewHandlers } from './browser-guest-view-ipc'
import {
  disposeGrabModeStateForPage,
  registerBrowserGrabHandlers,
  resetGrabModeState
} from './browser-grab-ipc'
import { registerBrowserSessionProfileHandlers } from './browser-session-profile-ipc'
import type { BrowserCertificateProceedResult } from '../../shared/browser-workspace-types'
import {
  cancelBrowserWebAuthnAccountRequests,
  respondToBrowserWebAuthnAccountRequest
} from '../browser/browser-webauthn-account-picker'
import type { BrowserWebAuthnAccountResponse } from '../../shared/browser-webauthn-account'

let agentBrowserBridgeRef: AgentBrowserBridge | null = null

type BrowserGuestRegistrationArgs = {
  browserPageId: string
  workspaceId: string
  worktreeId: string
  sessionProfileId?: string | null
  webContentsId: number
}

export function setAgentBrowserBridgeRef(bridge: AgentBrowserBridge | null): void {
  agentBrowserBridgeRef = bridge
}

export function registerBrowserHandlers(): void {
  resetGrabModeState()
  ipcMain.removeHandler('browser:registerGuest')
  ipcMain.removeHandler('browser:isGuestRegistered')
  ipcMain.removeHandler('browser:repairGuestRegistration')
  ipcMain.removeHandler('browser:unregisterGuest')
  ipcMain.removeHandler('browser:activeTabChanged')
  ipcMain.removeHandler('browser:proceedCertificate')
  ipcMain.removeHandler('browser:respondWebAuthnAccount')

  const registerGuest = (
    event: Electron.IpcMainInvokeEvent,
    args: BrowserGuestRegistrationArgs,
    repairPolicies: boolean
  ): boolean => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    if (
      !args ||
      typeof args.browserPageId !== 'string' ||
      typeof args.workspaceId !== 'string' ||
      typeof args.worktreeId !== 'string' ||
      typeof args.webContentsId !== 'number'
    ) {
      return false
    }
    if (repairPolicies) {
      const guest = webContents.fromId(args.webContentsId)
      if (
        !guest ||
        guest.isDestroyed() ||
        guest.getType() !== 'webview' ||
        guest.hostWebContents?.id !== event.sender.id
      ) {
        return false
      }
      browserManager.attachGuestPolicies(guest)
    }
    // Why: when Chromium swaps a guest's renderer process (navigation,
    // crash recovery), the renderer re-registers the same browserPageId
    // with a new webContentsId. The bridge must destroy the old session's
    // proxy (its webContents is gone) and let the next command recreate it.
    const previousWcId = browserManager.getGuestWebContentsId(args.browserPageId)
    const profile = browserSessionRegistry.getProfile(args.sessionProfileId ?? 'default')
    const registered = browserManager.registerGuest({
      ...args,
      userAgentMode: profile?.userAgentMode,
      rendererWebContentsId: event.sender.id
    })
    if (!registered) {
      return false
    }
    if (agentBrowserBridgeRef && previousWcId !== null && previousWcId !== args.webContentsId) {
      agentBrowserBridgeRef.onProcessSwap(args.browserPageId, args.webContentsId, previousWcId)
    }
    resolveTabRegistrationWaiters(args.browserPageId, args.worktreeId)
    return true
  }

  ipcMain.handle('browser:registerGuest', (event, args: BrowserGuestRegistrationArgs) =>
    registerGuest(event, args, false)
  )

  // Why: an SSH workspace's page may only mount on a proxy-verified partition,
  // so the renderer asks main to prepare it and blocks the webview until then.
  ipcMain.handle(
    'browser:prepareSshWorkspacePartition',
    async (
      event,
      args: { targetId?: unknown; browserProfileId?: unknown; skipProbe?: unknown }
    ) => {
      // Why (review P1-2): preparing mints bindings whose LRU eviction destroys
      // cookie jars; only the trusted renderer naming a REGISTERED target may.
      if (!isTrustedBrowserRenderer(event.sender)) {
        throw new Error('browser_local_route_renderer_untrusted')
      }
      if (typeof args?.targetId !== 'string' || args.targetId.length === 0) {
        throw new Error('browser_local_route_target_invalid')
      }
      const { getSshConnectionStore } = await import('./ssh')
      const registered = getSshConnectionStore()
        ?.listTargets()
        .some((target) => target.id === args.targetId)
      if (!registered) {
        throw new Error('browser_local_route_target_invalid')
      }
      const { prepareLocalSshBrowserPartition } =
        await import('../browser/local-ssh-browser-partitions')
      return prepareLocalSshBrowserPartition({
        targetId: args.targetId,
        browserProfileId:
          typeof args.browserProfileId === 'string' && args.browserProfileId.length > 0
            ? args.browserProfileId
            : 'default',
        skipProbe: args.skipProbe === true
      })
    }
  )

  ipcMain.handle('browser:repairGuestRegistration', (event, args: BrowserGuestRegistrationArgs) =>
    registerGuest(event, args, true)
  )

  ipcMain.handle(
    'browser:isGuestRegistered',
    (event, args: { browserPageId?: unknown; webContentsId?: unknown }): boolean => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof args?.browserPageId !== 'string' ||
        typeof args.webContentsId !== 'number'
      ) {
        return false
      }
      return (
        browserManager.getGuestWebContentsId(args.browserPageId) === args.webContentsId &&
        isLiveBrowserWebContentsId(args.webContentsId)
      )
    }
  )

  ipcMain.handle('browser:unregisterGuest', (event, args: { browserPageId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    // Why the whole door and not just the manager call: a document page shares this renderer, and
    // the grab disposal below drops the intent an in-flight preview grab compares by identity —
    // that grab would then answer ok without ever arming. A document page withdraws by revoking
    // its grant, so its id arriving here is misaddressed however it got here.
    if (typeof args?.browserPageId !== 'string' || isWorkspaceDocPageId(args.browserPageId)) {
      return false
    }
    // Why: notify bridge before unregistering so it can destroy the session
    // process and proxy. Must happen before unregisterGuest clears the mapping.
    const wcId = browserManager.getGuestWebContentsId(args.browserPageId)
    if (wcId !== null && agentBrowserBridgeRef) {
      agentBrowserBridgeRef.onTabClosed(wcId)
    }
    cancelBrowserWebAuthnAccountRequests(args.browserPageId)
    browserManager.unregisterGuest(args.browserPageId)
    disposeGrabModeStateForPage(args.browserPageId)
    return true
  })

  ipcMain.handle(
    'browser:respondWebAuthnAccount',
    (event, response: BrowserWebAuthnAccountResponse): boolean => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      return respondToBrowserWebAuthnAccountRequest(event.sender, response)
    }
  )

  ipcMain.handle(
    'browser:proceedCertificate',
    (
      event,
      args: { browserPageId?: unknown; challengeId?: unknown }
    ): BrowserCertificateProceedResult => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof args?.browserPageId !== 'string' ||
        typeof args.challengeId !== 'string'
      ) {
        return { ok: false, reason: 'missing' }
      }
      return browserCertificateTrustController.proceed(args.browserPageId, args.challengeId)
    }
  )

  // Why: keeps the bridge's active tab in sync with the renderer's UI state.
  // Without this, a user switching tabs in the UI would leave the agent operating
  // on the previous tab, which is confusing.
  ipcMain.handle('browser:activeTabChanged', (event, args: { browserPageId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    if (!agentBrowserBridgeRef) {
      return false
    }
    const wcId = browserManager.getGuestWebContentsId(args.browserPageId)
    if (wcId !== null) {
      // Why: renderer tab changes are scoped to a worktree. If we only update
      // the global active guest, later worktree-scoped commands can still
      // resolve to the previously active page inside that worktree.
      agentBrowserBridgeRef.onTabChanged(
        wcId,
        browserManager.getWorktreeIdForTab(args.browserPageId)
      )
    }
    return true
  })

  registerBrowserGuestViewHandlers()

  // --- Browser Context Grab IPC ---

  registerBrowserGrabHandlers()

  // --- Browser Session Profile IPC ---

  registerBrowserSessionProfileHandlers()
}
