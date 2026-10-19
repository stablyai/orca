import type {
  BrowserNetworkLogResult,
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserGeolocationResult,
  BrowserInterceptDisableResult,
  BrowserInterceptEnableResult,
  BrowserViewportResult
} from '../../../shared/runtime-types'
import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

export class RuntimeBrowserNetwork {
  constructor(
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget'
    >
  ) {}

  async browserNetworkLog(
    params: { limit?: number } & BrowserCommandTargetParams
  ): Promise<BrowserNetworkLogResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .networkLog(params.limit, target.worktreeId, target.browserPageId)
  }

  async browserCookieGet(
    params: { url?: string } & BrowserCommandTargetParams
  ): Promise<BrowserCookieGetResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .cookieGet(params.url, target.worktreeId, target.browserPageId)
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
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .cookieSet(params, target.worktreeId, target.browserPageId)
  }

  async browserCookieDelete(
    params: {
      name: string
      domain?: string
      url?: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserCookieDeleteResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .cookieDelete(params.name, params.domain, params.url, target.worktreeId, target.browserPageId)
  }

  async browserSetViewport(
    params: {
      width: number
      height: number
      deviceScaleFactor?: number
      mobile?: boolean
    } & BrowserCommandTargetParams
  ): Promise<BrowserViewportResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .setViewport(
        params.width,
        params.height,
        params.deviceScaleFactor,
        params.mobile,
        target.worktreeId,
        target.browserPageId
      )
  }

  async browserSetGeolocation(
    params: {
      latitude: number
      longitude: number
      accuracy?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserGeolocationResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .setGeolocation(
        params.latitude,
        params.longitude,
        params.accuracy,
        target.worktreeId,
        target.browserPageId
      )
  }

  async browserInterceptEnable(
    params: {
      patterns?: string[]
    } & BrowserCommandTargetParams
  ): Promise<BrowserInterceptEnableResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .interceptEnable(params.patterns, target.worktreeId, target.browserPageId)
  }

  async browserInterceptDisable(
    params: BrowserCommandTargetParams
  ): Promise<BrowserInterceptDisableResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .interceptDisable(target.worktreeId, target.browserPageId)
  }

  async browserInterceptList(params: BrowserCommandTargetParams): Promise<{ requests: unknown[] }> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .interceptList(target.worktreeId, target.browserPageId)
  }

  async browserSetDevice(params: { name: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .setDevice(params.name, target.worktreeId, target.browserPageId)
  }

  async browserSetOffline(
    params: { state?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .setOffline(params.state, target.worktreeId, target.browserPageId)
  }

  async browserSetHeaders(
    params: { headers: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .setHeaders(params.headers, target.worktreeId, target.browserPageId)
  }

  async browserSetCredentials(
    params: {
      user: string
      pass: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .setCredentials(params.user, params.pass, target.worktreeId, target.browserPageId)
  }

  async browserSetMedia(
    params: {
      colorScheme?: string
      reducedMotion?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .setMedia(params.colorScheme, params.reducedMotion, target.worktreeId, target.browserPageId)
  }

  async browserDownload(
    params: {
      selector: string
      path: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .download(params.selector, params.path, target.worktreeId, target.browserPageId)
  }
}
