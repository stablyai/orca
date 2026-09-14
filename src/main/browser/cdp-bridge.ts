import type {
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserCheckResult,
  BrowserClearResult,
  BrowserClickResult,
  BrowserConsoleResult,
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserDragResult,
  BrowserEvalResult,
  BrowserFillResult,
  BrowserFocusResult,
  BrowserGeolocationResult,
  BrowserGotoResult,
  BrowserHoverResult,
  BrowserInterceptDisableResult,
  BrowserInterceptEnableResult,
  BrowserInterceptedRequest,
  BrowserKeypressResult,
  BrowserNetworkLogResult,
  BrowserPdfResult,
  BrowserScreenshotResult,
  BrowserScrollResult,
  BrowserSelectAllResult,
  BrowserSelectResult,
  BrowserSnapshotResult,
  BrowserTabListResult,
  BrowserTabSwitchResult,
  BrowserTypeResult,
  BrowserUploadResult,
  BrowserViewportResult,
  BrowserWaitResult
} from '../../shared/runtime-types'
import type { BrowserManager } from './browser-manager'
import type { CdpAuxiliaryCommands, CdpTabState } from './cdp-auxiliary-commands'
import { CdpBridgeCommandSet } from './cdp-bridge-command-set'
import { CdpBridgeState, type CdpQueuedCommand } from './cdp-bridge-state'

// Why re-exported: moved to ./browser-error so the runtime can catch it without
// pulling Chromium in. Existing importers of this path keep working.
export { BrowserError } from './browser-error'

export class CdpBridge {
  private activeWebContentsId: number | null = null
  private readonly tabState = new Map<string, CdpTabState>()
  private readonly commandQueues = new Map<string, CdpQueuedCommand[]>()
  private readonly processingQueues = new Set<string>()
  private readonly browserManager: BrowserManager
  private readonly bridgeState: CdpBridgeState
  private readonly commands: CdpBridgeCommandSet
  private readonly auxiliaryCommands: CdpAuxiliaryCommands

  constructor(browserManager: BrowserManager) {
    this.browserManager = browserManager
    this.bridgeState = new CdpBridgeState({
      getActiveWebContentsId: () => this.activeWebContentsId,
      setActiveWebContentsId: (webContentsId) => {
        this.activeWebContentsId = webContentsId
      },
      getRegisteredTabs: () => this.getRegisteredTabs(),
      getTabIdForWebContentsId: (webContentsId) =>
        this.browserManager.getTabIdForWebContentsId(webContentsId),
      tabState: this.tabState,
      commandQueues: this.commandQueues,
      processingQueues: this.processingQueues
    })
    this.commands = new CdpBridgeCommandSet(this.bridgeState)
    this.auxiliaryCommands = this.commands.auxiliary
  }

  setActiveTab(webContentsId: number): void {
    this.commands.tabs.setActiveTab(webContentsId)
  }

  getActiveWebContentsId(): number | null {
    return this.commands.tabs.getActiveWebContentsId()
  }

  getActivePageId(_worktreeId?: string): string | null {
    return this.commands.tabs.getActivePageId(_worktreeId)
  }

  getPageInfo(
    _worktreeId?: string,
    browserPageId?: string
  ): { browserPageId: string; url: string; title: string } | null {
    return this.commands.tabs.getPageInfo(_worktreeId, browserPageId)
  }

  async snapshot(): Promise<BrowserSnapshotResult> {
    return this.commands.page.snapshot()
  }

  async click(element: string): Promise<BrowserClickResult> {
    return this.commands.pointer.click(element)
  }

  async hover(element: string): Promise<BrowserHoverResult> {
    return this.commands.pointer.hover(element)
  }

  async drag(fromElement: string, toElement: string): Promise<BrowserDragResult> {
    return this.commands.pointer.drag(fromElement, toElement)
  }

  async uploadFile(element: string, filePaths: string[]): Promise<BrowserUploadResult> {
    return this.commands.elements.uploadFile(element, filePaths)
  }

  async goto(url: string): Promise<BrowserGotoResult> {
    return this.commands.page.goto(url)
  }

  async fill(element: string, value: string): Promise<BrowserFillResult> {
    return this.commands.textInput.fill(element, value)
  }

  async type(input: string): Promise<BrowserTypeResult> {
    return this.commands.textInput.type(input)
  }

  async select(element: string, value: string): Promise<BrowserSelectResult> {
    return this.commands.elements.select(element, value)
  }

  async scroll(direction: 'up' | 'down', amount?: number): Promise<BrowserScrollResult> {
    return this.commands.page.scroll(direction, amount)
  }

  async wait(timeoutMs = 5000): Promise<BrowserWaitResult> {
    return this.commands.page.wait(timeoutMs)
  }

  async check(element: string, checked: boolean): Promise<BrowserCheckResult> {
    return this.commands.elements.check(element, checked)
  }

  async focus(element: string): Promise<BrowserFocusResult> {
    return this.commands.textInput.focus(element)
  }

  async clear(element: string): Promise<BrowserClearResult> {
    return this.commands.textInput.clear(element)
  }

  async selectAll(element: string): Promise<BrowserSelectAllResult> {
    return this.commands.textInput.selectAll(element)
  }

  async keypress(key: string): Promise<BrowserKeypressResult> {
    return this.commands.textInput.keypress(key)
  }

  async pdf(): Promise<BrowserPdfResult> {
    return this.commands.page.pdf()
  }

  async fullPageScreenshot(format: 'png' | 'jpeg' = 'png'): Promise<BrowserScreenshotResult> {
    return this.commands.page.fullPageScreenshot(format)
  }

  // ── Cookie management ──

  cookieGet(url?: string): Promise<BrowserCookieGetResult> {
    return this.auxiliaryCommands.cookieGet(url)
  }

  cookieSet(cookie: {
    name: string
    value: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: string
    expires?: number
  }): Promise<BrowserCookieSetResult> {
    return this.auxiliaryCommands.cookieSet(cookie)
  }

  cookieDelete(name: string, domain?: string, url?: string): Promise<BrowserCookieDeleteResult> {
    return this.auxiliaryCommands.cookieDelete(name, domain, url)
  }

  // ── Viewport emulation ──

  setViewport(
    width: number,
    height: number,
    deviceScaleFactor = 1,
    mobile = false
  ): Promise<BrowserViewportResult> {
    return this.auxiliaryCommands.setViewport(width, height, deviceScaleFactor, mobile)
  }

  // ── Geolocation ──

  setGeolocation(
    latitude: number,
    longitude: number,
    accuracy = 1
  ): Promise<BrowserGeolocationResult> {
    return this.auxiliaryCommands.setGeolocation(latitude, longitude, accuracy)
  }

  // ── Request interception ──

  interceptEnable(patterns: string[] = ['*']): Promise<BrowserInterceptEnableResult> {
    return this.auxiliaryCommands.interceptEnable(patterns)
  }

  interceptDisable(): Promise<BrowserInterceptDisableResult> {
    return this.auxiliaryCommands.interceptDisable()
  }

  interceptList(): { requests: BrowserInterceptedRequest[] } {
    return this.auxiliaryCommands.interceptList()
  }

  // TODO: Add interceptContinue/interceptBlock once agent-browser supports per-request decisions (CLI is URL-pattern-only).

  // ── Console/network capture ──

  captureStart(): Promise<BrowserCaptureStartResult> {
    return this.auxiliaryCommands.captureStart()
  }

  captureStop(): Promise<BrowserCaptureStopResult> {
    return this.auxiliaryCommands.captureStop()
  }

  consoleLog(limit = 100): BrowserConsoleResult {
    return this.auxiliaryCommands.consoleLog(limit)
  }

  networkLog(limit = 100): BrowserNetworkLogResult {
    return this.auxiliaryCommands.networkLog(limit)
  }

  async back(): Promise<{ url: string; title: string }> {
    return this.commands.page.back()
  }

  async reload(): Promise<{ url: string; title: string }> {
    return this.commands.page.reload()
  }

  async screenshot(format: 'png' | 'jpeg' = 'png'): Promise<BrowserScreenshotResult> {
    return this.commands.page.screenshot(format)
  }

  async evaluate(expression: string): Promise<BrowserEvalResult> {
    return this.commands.page.evaluate(expression)
  }

  tabList(): BrowserTabListResult {
    return this.commands.tabs.tabList()
  }

  async tabSwitch(index: number): Promise<BrowserTabSwitchResult> {
    return this.commands.tabs.tabSwitch(index)
  }

  onTabClosed(webContentsId: number): void {
    this.commands.tabs.onTabClosed(webContentsId)
  }

  onTabChanged(webContentsId: number): void {
    this.commands.tabs.onTabChanged(webContentsId)
  }

  private getRegisteredTabs(): Map<string, number> {
    // Why: reach into BrowserManager's private tab map since it exposes no public listTabs().
    return (this.browserManager as unknown as { webContentsIdByTabId: Map<string, number> })
      .webContentsIdByTabId
  }
}
