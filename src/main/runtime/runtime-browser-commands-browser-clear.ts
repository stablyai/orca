// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserTabList } from './runtime-browser-commands-browser-tab-list'
import type { BrowserCommandTargetParams } from './runtime-browser-commands-browser-command-target-params'
import type {
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserClearResult,
  BrowserConsoleResult,
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserGeolocationResult,
  BrowserInterceptDisableResult,
  BrowserInterceptEnableResult,
  BrowserKeypressResult,
  BrowserPdfResult,
  BrowserScreenshotResult,
  BrowserSelectAllResult,
  BrowserViewportResult
} from '../../shared/runtime-types'

export class RuntimeBrowserCommandsWithBrowserClear extends RuntimeBrowserCommandsWithBrowserTabList {
  async browserClear(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserClearResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clear(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSelectAll(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserSelectAllResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().selectAll(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserKeypress(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<BrowserKeypressResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().keypress(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserPdf(params: BrowserCommandTargetParams): Promise<BrowserPdfResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().pdf(target.worktreeId, target.browserPageId)
  }

  async browserFullScreenshot(
    params: {
      format?: 'png' | 'jpeg'
    } & BrowserCommandTargetParams
  ): Promise<BrowserScreenshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().fullPageScreenshot(
      params.format,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Cookie management ──

  async browserCookieGet(
    params: { url?: string } & BrowserCommandTargetParams
  ): Promise<BrowserCookieGetResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieGet(
      params.url,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserCookieSet(
    params: {
      name: string
      value: string
      domain?: string
      path?: string
      secure?: boolean
      httpOnly?: boolean
      sameSite?: string
      expires?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserCookieSetResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieSet(
      params,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserCookieDelete(
    params: {
      name: string
      domain?: string
      url?: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserCookieDeleteResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieDelete(
      params.name,
      params.domain,
      params.url,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Viewport ──

  async browserSetViewport(
    params: {
      width: number
      height: number
      deviceScaleFactor?: number
      mobile?: boolean
    } & BrowserCommandTargetParams
  ): Promise<BrowserViewportResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setViewport(
      params.width,
      params.height,
      params.deviceScaleFactor,
      params.mobile,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Geolocation ──

  async browserSetGeolocation(
    params: {
      latitude: number
      longitude: number
      accuracy?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserGeolocationResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setGeolocation(
      params.latitude,
      params.longitude,
      params.accuracy,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Request interception ──

  async browserInterceptEnable(
    params: {
      patterns?: string[]
    } & BrowserCommandTargetParams
  ): Promise<BrowserInterceptEnableResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptEnable(
      params.patterns,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserInterceptDisable(
    params: BrowserCommandTargetParams
  ): Promise<BrowserInterceptDisableResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptDisable(
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserInterceptList(params: BrowserCommandTargetParams): Promise<{ requests: unknown[] }> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptList(target.worktreeId, target.browserPageId)
  }

  // ── Console/network capture ──

  async browserCaptureStart(
    params: BrowserCommandTargetParams
  ): Promise<BrowserCaptureStartResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().captureStart(target.worktreeId, target.browserPageId)
  }

  async browserCaptureStop(params: BrowserCommandTargetParams): Promise<BrowserCaptureStopResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().captureStop(target.worktreeId, target.browserPageId)
  }

  async browserConsoleLog(
    params: { limit?: number } & BrowserCommandTargetParams
  ): Promise<BrowserConsoleResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().consoleLog(
      params.limit,
      target.worktreeId,
      target.browserPageId
    )
  }
}
