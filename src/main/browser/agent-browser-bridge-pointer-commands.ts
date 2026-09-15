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
import { AgentBrowserBridgeInputCommands } from './agent-browser-bridge-input-commands'

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

/**
 * Coordinate pointer input (move/down/up/wheel), dispatched over the Electron debugger.
 *
 * Element-ref interactions stay on the agent-browser helper because they need its
 * accessibility snapshot; these four carry their own coordinates and need nothing from it.
 */
export abstract class AgentBrowserBridgePointerCommands extends AgentBrowserBridgeInputCommands {
  // Why: coordinate pointer input needs no accessibility snapshot, so it dispatches over
  // the debugger `mouseClick` already uses instead of spawning a helper per event.
  private async dispatchPointerEvent<T>(
    sessionName: string,
    target: ResolvedBrowserCommandTarget,
    describe: string,
    build: (state: CdpPointerState) => {
      params: CdpPointerEventParams
      focus?: boolean
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
    // Why: build() mutates the tracked state before the event is on the wire; a rejected
    // dispatch changed nothing in the page, so the pre-dispatch state is what is real —
    // keeping the mutation would leave a phantom held button on every later event.
    const preDispatch = { ...state }
    let releaseDebugger = (): void => {}

    try {
      releaseDebugger = acquireElectronDebugger(wc).release
      const { params, focus, result } = build(state)

      if (focus) {
        wc.focus()
      }

      await wc.debugger.sendCommand('Input.dispatchMouseEvent', params)

      return result
    } catch (error) {
      Object.assign(state, preDispatch)

      // Why: attach/dispatch reject with plain Errors, which the RPC layer would report as
      // runtime_error — the helper path this replaced always produced a browser_* code, and
      // the pane only reclaims a dead page when it sees one.
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
      releaseDebugger()
    }
  }

  async mouseMove(
    x: number,
    y: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(
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
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName, target) =>
        this.dispatchPointerEvent(sessionName, target, 'press the pointer', (state) => {
          const cdpButton = normalizeCdpPointerButton(button)
          pressCdpPointerButton(state, cdpButton)

          return {
            // Why: mirrors mouseClick — a press that does not focus the guest leaves
            // keyboard input going to whatever held focus before.
            focus: true,
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
    return this.enqueueTargetedCommand(
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
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName, target) =>
        this.dispatchPointerEvent(sessionName, target, 'scroll', (state) => {
          assertFinitePointerValues({ dy, ...(dx == null ? {} : { dx }) })
          const deltaX = dx ?? 0

          return {
            // Why: dispatch at the tracked position so the scrollable under the cursor
            // scrolls; the helper always dispatched wheel at (0,0).
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
