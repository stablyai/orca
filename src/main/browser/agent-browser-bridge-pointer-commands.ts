import type { ResolvedBrowserCommandTarget } from './agent-browser-bridge-types'
import { BrowserError } from './cdp-bridge'
import { normalizeCdpPointerButton } from './agent-browser-bridge-mouse'
import {
  assertFinitePointerValues,
  cdpPointerStateFor,
  pressCdpPointerButton,
  releaseCdpPointerButton,
  resolveCdpPointerReleaseButton,
  type CdpPointerState
} from './cdp-pointer-input'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { AgentBrowserBridgeInputCommands } from './agent-browser-bridge-input-commands'
import { isEmbeddedGuest } from './guest-direct-key-input'
import { enablePageFocusEmulation } from './agent-input-focus-guard'
import { waitForGuestFirstPaint } from './guest-first-paint'

type CdpPointerEventParams = {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'
  x: number
  y: number
  button?: string
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
}

/** Coordinate input needs no snapshot and can bypass the helper. */
export abstract class AgentBrowserBridgePointerCommands extends AgentBrowserBridgeInputCommands {
  private async dispatchPointerEvent<T>(
    sessionName: string,
    target: ResolvedBrowserCommandTarget,
    describe: string,
    build: (state: CdpPointerState) => {
      params: CdpPointerEventParams
      press?: boolean
      result: T
    }
  ): Promise<T> {
    const wc = this.getWebContents(target.webContentsId)
    if (!wc || wc.isDestroyed()) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${target.browserPageId} is no longer available`
      )
    }
    const state = cdpPointerStateFor(wc)
    // Restore tracked state if dispatch fails, or later events report phantom held buttons.
    const preDispatch = { ...state }
    let releaseDebugger = (): void => {}
    let releaseFocusGuard = (): void => {}
    try {
      releaseDebugger = acquireElectronDebugger(wc).release
      const { params, press, result } = build(state)
      await this.waitForPagePaint(wc, target.webContentsId)
      await this.browserManager.showAgentPointer(wc, params)
      if (press) {
        releaseFocusGuard = await this.focusPageForPress(wc, target.webContentsId)
      }
      await sendGuestCdpCommand(wc, 'Input.dispatchMouseEvent', params)
      return result
    } catch (error) {
      Object.assign(state, preDispatch)
      // Browser error codes let the pane recognize and reclaim a dead page.
      if (error instanceof BrowserError) {
        throw error
      }
      if (!this.getWebContents(target.webContentsId)) {
        throw this.createPageUnavailableError(sessionName)
      }
      throw new BrowserError(
        'browser_error',
        `Failed to ${describe} in browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      releaseFocusGuard()
      releaseDebugger()
    }
  }

  // Bridge input skips the CDP proxy's queue, so it waits for the first paint itself.
  protected async waitForPagePaint(wc: Electron.WebContents, webContentsId: number): Promise<void> {
    await waitForGuestFirstPaint(
      wc,
      (method, params, sessionId) => sendGuestCdpCommand(wc, method, params, sessionId),
      () => this.browserManager.holdPaintForCapture(webContentsId)
    )
  }

  // Guard embedded-guest presses to restore user focus; emulation prevents page blur.
  // Offscreen pages need native focus for caret and IME input.
  protected async focusPageForPress(
    wc: Electron.WebContents,
    webContentsId: number
  ): Promise<() => void> {
    if (!isEmbeddedGuest(wc)) {
      wc.focus()
      return () => {}
    }
    await enablePageFocusEmulation((method, params) => wc.debugger.sendCommand(method, params))
    return await this.browserManager.guardUserFocusForAgentInput(webContentsId)
  }

  async mouseMove(
    x: number,
    y: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName, target) =>
        this.dispatchPointerEvent(sessionName, target, 'move the pointer', (state) => {
          assertFinitePointerValues({ x, y })
          state.x = x
          state.y = y
          return {
            params: {
              type: 'mouseMoved',
              x,
              y,
              button: state.button,
              buttons: state.buttons
            },
            result: { moved: true }
          }
        }),
      { ensureSession: false }
    )
  }

  async mouseDown(button?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName, target) =>
        this.dispatchPointerEvent(sessionName, target, 'press the pointer', (state) => {
          const cdpButton = normalizeCdpPointerButton(button)
          pressCdpPointerButton(state, cdpButton)
          return {
            press: true,
            params: {
              type: 'mousePressed',
              x: state.x,
              y: state.y,
              button: cdpButton,
              buttons: state.buttons,
              clickCount: state.clickCount
            },
            result: { pressed: true }
          }
        }),
      { ensureSession: false }
    )
  }

  async mouseUp(button?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName, target) =>
        this.dispatchPointerEvent(sessionName, target, 'release the pointer', (state) => {
          const cdpButton = normalizeCdpPointerButton(
            button ?? resolveCdpPointerReleaseButton(state)
          )
          releaseCdpPointerButton(state, cdpButton)
          return {
            params: {
              type: 'mouseReleased',
              x: state.x,
              y: state.y,
              button: cdpButton,
              buttons: state.buttons,
              clickCount: state.clickCount
            },
            result: { released: true }
          }
        }),
      { ensureSession: false }
    )
  }

  async mouseWheel(
    dy: number,
    dx?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName, target) =>
        this.dispatchPointerEvent(sessionName, target, 'scroll', (state) => {
          assertFinitePointerValues({ dy, ...(dx == null ? {} : { dx }) })
          const deltaX = dx ?? 0
          return {
            // Wheel events must target the scrollable under the tracked cursor.
            params: {
              type: 'mouseWheel',
              x: state.x,
              y: state.y,
              deltaX,
              deltaY: dy,
              buttons: state.buttons
            },
            result: { scrolled: true, deltaX, deltaY: dy }
          }
        }),
      { ensureSession: false }
    )
  }
}
