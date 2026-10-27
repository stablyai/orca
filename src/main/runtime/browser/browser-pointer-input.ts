import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
import { clampOptionalNumber } from './browser-screencast-budget'

export class RuntimeBrowserPointerInput {
  constructor(
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget'
    >
  ) {}

  async browserKeyboardInsertText(
    params: { text: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .keyboardInsertText(params.text, target.worktreeId, target.browserPageId)
  }

  async browserMouseMove(
    params: { x: number; y: number } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .mouseMove(params.x, params.y, target.worktreeId, target.browserPageId)
  }

  async browserMouseDown(
    params: { button?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .mouseDown(params.button, target.worktreeId, target.browserPageId)
  }

  async browserMouseClick(
    params: {
      x: number
      y: number
      button?: string
      radius?: number
      modifiers?: ('cmd' | 'ctrl' | 'alt' | 'shift')[]
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .mouseClick(
        params.x,
        params.y,
        params.button,
        target.worktreeId,
        target.browserPageId,
        clampOptionalNumber(params.radius, 0, 64),
        params.modifiers
      )
  }

  async browserMouseUp(params: { button?: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .mouseUp(params.button, target.worktreeId, target.browserPageId)
  }

  async browserMouseWheel(
    params: {
      dy: number
      dx?: number
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .mouseWheel(params.dy, params.dx, target.worktreeId, target.browserPageId)
  }
}
