import { ipcMain, webContents } from 'electron'
import { browserCertificateTrustController, browserManager } from '../browser/browser-manager'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
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
import type {
  BrowserPagePromptResponse,
  BrowserPagePromptResult
} from '../../shared/browser-page-prompt'
import { respondToBrowserPagePrompt } from '../browser/browser-page-prompts'
import { recordActiveBrowserPage } from '../browser/extensions/browser-extension-tab-model'
import { announceRegisteredBrowserExtensionTab } from '../browser/extensions/api/tabs-lifecycle'
import { registerBrowserExtensionHandlers } from './browser-extensions'
import { registerBrowserExtensionContextMenuHandlers } from './browser-extension-context-menu'

let agentBrowserBridgeRef: AgentBrowserBridge | null = null

export type BrowserGuestArgs = {
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
  ipcMain.removeHandler('browser:respondPagePrompt')

  const registerGuest = (
    event: Electron.IpcMainInvokeEvent,
    args: BrowserGuestArgs,
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
    // Guest process swaps require retiring the old proxy; the next command recreates it.
    const previousWcId = browserManager.getGuestWebContentsId(args.browserPageId)
    const registered = browserManager.registerGuest({
      ...args,
      rendererWebContentsId: event.sender.id
    })
    if (!registered) {
      return false
    }
    if (agentBrowserBridgeRef && previousWcId !== null && previousWcId !== args.webContentsId) {
      agentBrowserBridgeRef.onProcessSwap(args.browserPageId, args.webContentsId, previousWcId)
    }
    resolveTabRegistrationWaiters(args.browserPageId, args.worktreeId)
    announceRegisteredBrowserExtensionTab(args.browserPageId, args.webContentsId)
    return true
  }

  ipcMain.handle('browser:registerGuest', (event, args: BrowserGuestArgs) =>
    registerGuest(event, args, false)
  )

  // Block SSH webview mounting until its proxy-verified partition is ready.
  ipcMain.handle(
    'browser:prepareSshWorkspacePartition',
    async (
      event,
      args: {
        targetId?: unknown
        browserProfileId?: unknown
        skipProbe?: unknown
        expectedSshTargetGeneration?: unknown
      }
    ) => {
      // Preparation can evict cookie jars; require a trusted renderer and registered target.
      if (!isTrustedBrowserRenderer(event.sender)) {
        throw new Error('browser_local_route_renderer_untrusted')
      }
      if (typeof args?.targetId !== 'string' || args.targetId.length === 0) {
        throw new Error('browser_local_route_target_invalid')
      }
      const { getSshConnectionStore } = await import('./ssh/ssh')
      const { requireLocalSshBrowserRouteTarget } =
        await import('../browser/local-ssh-browser-route')
      requireLocalSshBrowserRouteTarget(
        getSshConnectionStore()?.listTargets(),
        args.targetId,
        args.expectedSshTargetGeneration
      )
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

  ipcMain.handle('browser:repairGuestRegistration', (event, args: BrowserGuestArgs) =>
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
    // Documents withdraw by grant revocation; dropping their intent here could silently settle an unarmed grab.
    if (typeof args?.browserPageId !== 'string' || isWorkspaceDocPageId(args.browserPageId)) {
      return false
    }
    // Destroy bridge sessions before unregistering clears the guest mapping.
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
    'browser:respondPagePrompt',
    (event, response: BrowserPagePromptResponse): Promise<BrowserPagePromptResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return Promise.resolve('rejected')
      }
      return respondToBrowserPagePrompt(event.sender, response)
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

  // Keep agent commands aligned with the tab the user selected.
  ipcMain.handle('browser:activeTabChanged', (event, args: { browserPageId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender) || typeof args?.browserPageId !== 'string') {
      return false
    }
    // Why before the bridge check: extensions need the active tab even when no agent bridge exists.
    recordActiveBrowserPage(args.browserPageId)
    if (!agentBrowserBridgeRef) {
      return false
    }
    const wcId = browserManager.getGuestWebContentsId(args.browserPageId)
    if (wcId !== null) {
      // Update worktree-scoped active state as well as the global guest.
      agentBrowserBridgeRef.onTabChanged(
        wcId,
        browserManager.getWorktreeIdForTab(args.browserPageId)
      )
    }
    return true
  })

  registerBrowserGuestViewHandlers()

  registerBrowserGrabHandlers()

  registerBrowserSessionProfileHandlers()

  registerBrowserExtensionHandlers()
  registerBrowserExtensionContextMenuHandlers()
}
