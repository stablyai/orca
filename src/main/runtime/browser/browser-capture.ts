import type {
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserConsoleResult,
  BrowserPdfResult,
  BrowserEvalResult
} from '../../../shared/runtime-types'
import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

export class RuntimeBrowserCapture {
  constructor(
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget'
    >
  ) {}

  async browserScreenshot(
    params: BrowserScreenshotOptions & BrowserCommandTargetParams
  ): Promise<BrowserScreenshotResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .screenshot(params, target.worktreeId, target.browserPageId)
  }

  async browserPdf(params: BrowserCommandTargetParams): Promise<BrowserPdfResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets.requireAgentBrowserBridge().pdf(target.worktreeId, target.browserPageId)
  }

  async browserFullScreenshot(
    params: {
      format?: 'png' | 'jpeg'
    } & BrowserCommandTargetParams
  ): Promise<BrowserScreenshotResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .fullPageScreenshot(params.format, target.worktreeId, target.browserPageId)
  }

  async browserCaptureStart(
    params: BrowserCommandTargetParams
  ): Promise<BrowserCaptureStartResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .captureStart(target.worktreeId, target.browserPageId)
  }

  async browserCaptureStop(params: BrowserCommandTargetParams): Promise<BrowserCaptureStopResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .captureStop(target.worktreeId, target.browserPageId)
  }

  async browserConsoleLog(
    params: { limit?: number } & BrowserCommandTargetParams
  ): Promise<BrowserConsoleResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .consoleLog(params.limit, target.worktreeId, target.browserPageId)
  }

  async browserEval(
    params: { expression: string } & BrowserCommandTargetParams,
    signal?: AbortSignal
  ): Promise<BrowserEvalResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .evaluate(params.expression, target.worktreeId, target.browserPageId, signal)
  }
}
