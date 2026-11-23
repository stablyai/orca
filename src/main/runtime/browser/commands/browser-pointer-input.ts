import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
import { clampOptionalNumber } from '../screencast/browser-screencast-budget'
import type { BrowserMouseModifier } from '../../../browser/cdp/input/cdp-pointer-targets'
import { BrowserError } from '../../../browser/browser-error'

type BrowserMouseButtonParams = {
  button?: string
  modifiers?: BrowserMouseModifier[]
} & BrowserCommandTargetParams

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

  async browserMouseDown(params: BrowserMouseButtonParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .mouseDown(params.button, target.worktreeId, target.browserPageId, params.modifiers)
  }

  async browserMouseClick(
    params: {
      x: number
      y: number
      button?: string
      radius?: number
      modifiers?: BrowserMouseModifier[]
      fileChooserRefusal?: 1
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    try {
      return await this.targets
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
    } catch (error) {
      // Only phones send a radius; shipped ones replay a failed tap as a press, clicking the page twice.
      if (
        params.radius !== undefined &&
        params.fileChooserRefusal !== 1 &&
        error instanceof BrowserError &&
        error.code === 'browser_file_chooser_opened'
      ) {
        return {
          clicked: { x: params.x, y: params.y, button: 'left', adjusted: false, handled: true }
        }
      }
      throw error
    }
  }

  async browserDropFiles(
    params: { x: number; y: number; files: string[] } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .dropFiles(params.x, params.y, params.files, target.worktreeId, target.browserPageId)
  }

  async browserMouseUp(params: BrowserMouseButtonParams): Promise<unknown> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return this.targets
      .requireAgentBrowserBridge()
      .mouseUp(params.button, target.worktreeId, target.browserPageId, params.modifiers)
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
