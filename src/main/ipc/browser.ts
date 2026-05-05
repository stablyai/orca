/* eslint-disable max-lines -- Why: browser IPC handlers must be registered together so the
   trust boundary (isTrustedBrowserRenderer) and handler teardown stay consistent. */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { browserManager } from '../browser/browser-manager'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  pickCookieFile,
  importCookiesFromFile,
  detectInstalledBrowsers,
  selectBrowserProfile,
  importCookiesFromBrowser
} from '../browser/browser-cookie-import'
import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult
} from '../../shared/browser-grab-types'
import type {
  BrowserCookieImportResult,
  BrowserSessionProfile,
  BrowserSessionProfileScope,
  BrowserViewportOverride
} from '../../shared/types'

let trustedBrowserRendererWebContentsId: number | null = null
let agentBrowserBridgeRef: AgentBrowserBridge | null = null

// Why: CLI-driven tab creation must wait until the renderer mounts the webview
// and calls registerGuest, so the tab has a webContentsId and is operable by
// subsequent commands. This map holds one-shot resolvers keyed by browserPageId.
const pendingTabRegistrations = new Map<string, () => void>()

export function waitForTabRegistration(browserPageId: string, timeoutMs = 8_000): Promise<void> {
  if (browserManager.getGuestWebContentsId(browserPageId) !== null) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTabRegistrations.delete(browserPageId)
      reject(new Error('Tab registration timed out'))
    }, timeoutMs)
    pendingTabRegistrations.set(browserPageId, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function setTrustedBrowserRendererWebContentsId(webContentsId: number | null): void {
  trustedBrowserRendererWebContentsId = webContentsId
}

export function setAgentBrowserBridgeRef(bridge: AgentBrowserBridge | null): void {
  agentBrowserBridgeRef = bridge
}

function isTrustedBrowserRenderer(sender: Electron.WebContents): boolean {
  if (sender.isDestroyed() || sender.getType() !== 'window') {
    return false
  }
  if (trustedBrowserRendererWebContentsId != null) {
    return sender.id === trustedBrowserRendererWebContentsId
  }

  const senderUrl = sender.getURL()
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return new URL(senderUrl).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }

  return senderUrl.startsWith('file://')
}

export function registerBrowserHandlers(): void {
  ipcMain.removeHandler('browser:registerGuest')
  ipcMain.removeHandler('browser:unregisterGuest')
  ipcMain.removeHandler('browser:openDevTools')
  ipcMain.removeHandler('browser:setViewportOverride')
  ipcMain.removeHandler('browser:acceptDownload')
  ipcMain.removeHandler('browser:cancelDownload')
  ipcMain.removeHandler('browser:setGrabMode')
  ipcMain.removeHandler('browser:awaitGrabSelection')
  ipcMain.removeHandler('browser:cancelGrab')
  ipcMain.removeHandler('browser:captureSelectionScreenshot')
  ipcMain.removeHandler('browser:extractHoverPayload')
  ipcMain.removeHandler('browser:activeTabChanged')

  ipcMain.handle(
    'browser:registerGuest',
    (
      event,
      args: {
        browserPageId: string
        workspaceId: string
        worktreeId: string
        sessionProfileId?: string | null
        webContentsId: number
      }
    ) => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      // Why: when Chromium swaps a guest's renderer process (navigation,
      // crash recovery), the renderer re-registers the same browserPageId
      // with a new webContentsId. The bridge must destroy the old session's
      // proxy (its webContents is gone) and let the next command recreate it.
      const previousWcId = browserManager.getGuestWebContentsId(args.browserPageId)
      browserManager.registerGuest({
        ...args,
        rendererWebContentsId: event.sender.id
      })
      if (agentBrowserBridgeRef && previousWcId !== null && previousWcId !== args.webContentsId) {
        agentBrowserBridgeRef.onProcessSwap(args.browserPageId, args.webContentsId, previousWcId)
      }
      const pendingResolve = pendingTabRegistrations.get(args.browserPageId)
      if (pendingResolve) {
        pendingTabRegistrations.delete(args.browserPageId)
        pendingResolve()
      }
      return true
    }
  )

  ipcMain.handle('browser:unregisterGuest', (event, args: { browserPageId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    // Why: notify bridge before unregistering so it can destroy the session
    // process and proxy. Must happen before unregisterGuest clears the mapping.
    const wcId = browserManager.getGuestWebContentsId(args.browserPageId)
    if (wcId !== null && agentBrowserBridgeRef) {
      agentBrowserBridgeRef.onTabClosed(wcId)
    }
    browserManager.unregisterGuest(args.browserPageId)
    return true
  })

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

  ipcMain.handle('browser:openDevTools', (event, args: { browserPageId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserManager.openDevTools(args.browserPageId)
  })

  ipcMain.handle(
    'browser:setViewportOverride',
    (
      event,
      args: {
        browserPageId: string
        override: BrowserViewportOverride | null
      }
    ) => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      // Why: CDP misbehaves on non-finite/negative metrics (NaN/Infinity can
      // wedge Emulation.setDeviceMetricsOverride and leave the page in a
      // broken state). Validate at the main-process trust boundary so a buggy
      // or compromised renderer cannot corrupt CDP state.
      if (args.override !== null) {
        const { width, height, deviceScaleFactor, mobile } = args.override
        const isFinitePositive = (n: unknown): n is number =>
          typeof n === 'number' && Number.isFinite(n) && n > 0
        if (!isFinitePositive(width) || width < 1 || width > 10000) {
          return false
        }
        if (!isFinitePositive(height) || height < 1 || height > 10000) {
          return false
        }
        if (
          !isFinitePositive(deviceScaleFactor) ||
          deviceScaleFactor < 0.1 ||
          deviceScaleFactor > 5
        ) {
          return false
        }
        if (typeof mobile !== 'boolean') {
          return false
        }
      }
      return browserManager.setViewportOverride(args.browserPageId, args.override)
    }
  )

  ipcMain.handle('browser:acceptDownload', async (event, args: { downloadId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return { ok: false, reason: 'not-authorized' as const }
    }
    const prompt = browserManager.getDownloadPrompt(args.downloadId, event.sender.id)
    if (!prompt) {
      return { ok: false, reason: 'not-ready' as const }
    }

    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showSaveDialog(parent, { defaultPath: prompt.filename })
      : await dialog.showSaveDialog({ defaultPath: prompt.filename })
    if (result.canceled || !result.filePath) {
      browserManager.cancelDownload({
        downloadId: args.downloadId,
        senderWebContentsId: event.sender.id
      })
      return { ok: false, reason: 'canceled' as const }
    }

    return browserManager.acceptDownload({
      downloadId: args.downloadId,
      senderWebContentsId: event.sender.id,
      savePath: result.filePath
    })
  })

  ipcMain.handle('browser:cancelDownload', (event, args: { downloadId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserManager.cancelDownload({
      downloadId: args.downloadId,
      senderWebContentsId: event.sender.id
    })
  })

  // --- Browser Context Grab IPC ---

  ipcMain.handle(
    'browser:setGrabMode',
    async (event, args: BrowserSetGrabModeArgs): Promise<BrowserSetGrabModeResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'not-authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { ok: false, reason: 'not-ready' }
      }
      const success = await browserManager.setGrabMode(args.browserPageId, args.enabled, guest)
      return success ? { ok: true } : { ok: false, reason: 'not-ready' }
    }
  )

  ipcMain.handle(
    'browser:awaitGrabSelection',
    async (event, args: BrowserAwaitGrabSelectionArgs): Promise<BrowserGrabResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { opId: args.opId, kind: 'error', reason: 'Not authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { opId: args.opId, kind: 'error', reason: 'Guest not ready' }
      }
      // Why: no hasActiveGrabOp guard here — awaitGrabSelection already handles
      // the conflict by cancelling the previous op. Blocking at the IPC layer
      // would create a race window where rearm() fails if the previous IPC call
      // hasn't fully resolved yet.
      return browserManager.awaitGrabSelection(args.browserPageId, args.opId, guest)
    }
  )

  ipcMain.handle('browser:cancelGrab', (event, args: BrowserCancelGrabArgs): boolean => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    // Why: verify the sender actually owns this tab, consistent with the
    // authorization check in setGrabMode/awaitGrabSelection/captureScreenshot.
    const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
    if (!guest) {
      return false
    }
    browserManager.cancelGrabOp(args.browserPageId, 'user')
    return true
  })

  ipcMain.handle(
    'browser:captureSelectionScreenshot',
    async (
      event,
      args: BrowserCaptureSelectionScreenshotArgs
    ): Promise<BrowserCaptureSelectionScreenshotResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { ok: false, reason: 'Guest not ready' }
      }
      const screenshot = await browserManager.captureSelectionScreenshot(
        args.browserPageId,
        args.rect,
        guest
      )
      if (!screenshot) {
        return { ok: false, reason: 'Screenshot capture failed' }
      }
      return { ok: true, screenshot }
    }
  )

  ipcMain.handle(
    'browser:extractHoverPayload',
    async (event, args: BrowserExtractHoverArgs): Promise<BrowserExtractHoverResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { ok: false, reason: 'Guest not ready' }
      }
      const payload = await browserManager.extractHoverPayload(args.browserPageId, guest)
      if (!payload) {
        return { ok: false, reason: 'No element hovered' }
      }
      return { ok: true, payload }
    }
  )

  // --- Browser Session Profile IPC ---

  ipcMain.removeHandler('browser:session:listProfiles')
  ipcMain.removeHandler('browser:session:createProfile')
  ipcMain.removeHandler('browser:session:deleteProfile')
  ipcMain.removeHandler('browser:session:importCookies')
  ipcMain.removeHandler('browser:session:resolvePartition')

  ipcMain.handle('browser:session:listProfiles', (event): BrowserSessionProfile[] => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return []
    }
    return browserSessionRegistry.listProfiles()
  })

  ipcMain.handle(
    'browser:session:createProfile',
    (
      event,
      args: { scope: BrowserSessionProfileScope; label: string }
    ): BrowserSessionProfile | null => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return null
      }
      return browserSessionRegistry.createProfile(args.scope, args.label)
    }
  )

  ipcMain.handle(
    'browser:session:deleteProfile',
    async (event, args: { profileId: string }): Promise<boolean> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      return browserSessionRegistry.deleteProfile(args.profileId)
    }
  )

  ipcMain.handle(
    'browser:session:importCookies',
    async (event, args: { profileId: string }): Promise<BrowserCookieImportResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return { ok: false, reason: 'Session profile not found.' }
      }

      const parent = BrowserWindow.fromWebContents(event.sender)
      const filePath = await pickCookieFile(parent)
      if (!filePath) {
        return { ok: false, reason: 'canceled' }
      }

      const result = await importCookiesFromFile(filePath, profile.partition)
      if (result.ok) {
        browserSessionRegistry.updateProfileSource(args.profileId, {
          browserFamily: 'manual',
          importedAt: Date.now()
        })
        return { ...result, profileId: args.profileId }
      }
      return result
    }
  )

  ipcMain.handle(
    'browser:session:resolvePartition',
    (event, args: { profileId: string | null }): string | null => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return null
      }
      return browserSessionRegistry.resolvePartition(args.profileId)
    }
  )

  ipcMain.removeHandler('browser:session:clearDefaultCookies')

  ipcMain.handle('browser:session:clearDefaultCookies', async (event): Promise<boolean> => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserSessionRegistry.clearDefaultSessionCookies()
  })

  ipcMain.removeHandler('browser:session:detectBrowsers')
  ipcMain.removeHandler('browser:session:importFromBrowser')

  ipcMain.handle(
    'browser:session:detectBrowsers',
    (
      event
    ): {
      family: string
      label: string
      profiles: { name: string; directory: string }[]
      selectedProfile: string
    }[] => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return []
      }
      // Why: the renderer only needs family/label/profiles for the UI picker.
      // Strip cookiesPath, keychainService, and keychainAccount to avoid
      // exposing filesystem paths and credential store identifiers to the renderer.
      return detectInstalledBrowsers().map((b) => ({
        family: b.family,
        label: b.label,
        profiles: b.profiles,
        selectedProfile: b.selectedProfile
      }))
    }
  )

  ipcMain.handle(
    'browser:session:importFromBrowser',
    async (
      event,
      args: { profileId: string; browserFamily: string; browserProfile?: string }
    ): Promise<BrowserCookieImportResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return { ok: false, reason: 'Session profile not found.' }
      }

      // Why: browserProfile comes from the renderer and is used to construct
      // a filesystem path. Reject traversal characters to prevent a compromised
      // renderer from reading arbitrary files via the cookie import pipeline.
      if (
        args.browserProfile &&
        (/[/\\]/.test(args.browserProfile) || args.browserProfile.includes('..'))
      ) {
        return { ok: false, reason: 'Invalid browser profile name.' }
      }

      const browsers = detectInstalledBrowsers()
      let browser = browsers.find((b) => b.family === args.browserFamily)
      if (!browser) {
        return { ok: false, reason: 'Browser not found on this system.' }
      }

      // Why: if the user selected a non-default profile from the picker,
      // resolve the cookies path for that specific profile.
      if (args.browserProfile && args.browserProfile !== browser.selectedProfile) {
        const reselected = selectBrowserProfile(browser, args.browserProfile)
        if (!reselected) {
          return {
            ok: false,
            reason: `No cookies database found for profile "${args.browserProfile}".`
          }
        }
        browser = reselected
      }

      const result = await importCookiesFromBrowser(browser, profile.partition)
      if (result.ok) {
        const profileName =
          browser.profiles.find((p) => p.directory === browser.selectedProfile)?.name ??
          browser.selectedProfile
        browserSessionRegistry.updateProfileSource(args.profileId, {
          browserFamily: browser.family,
          profileName,
          importedAt: Date.now()
        })
        return { ...result, profileId: args.profileId }
      }
      return result
    }
  )
}
