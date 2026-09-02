import type { BrowserMouseModifier } from './agent-browser-bridge-types'
import { BrowserError } from './cdp-bridge'
import {
  normalizeCdpMouseButton,
  cdpMouseButtonMask,
  cdpMouseModifierMask,
  resolveMobileTouchClickPoint
} from './agent-browser-bridge-mouse'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { AgentBrowserBridgeInputCommands } from './agent-browser-bridge-input-commands'

export abstract class AgentBrowserBridgeMouseCommands extends AgentBrowserBridgeInputCommands {
  // ── Mouse commands ──

  async mouseMove(
    x: number,
    y: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['mouse', 'move', String(x), String(y)])
    })
  }

  async mouseDown(button?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['mouse', 'down']
      if (button) {
        args.push(button)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async mouseClick(
    x: number,
    y: number,
    button?: string,
    worktreeId?: string,
    browserPageId?: string,
    radius?: number,
    modifiers?: BrowserMouseModifier[]
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.getWebContents(target.webContentsId)
        if (!wc || wc.isDestroyed()) {
          throw new BrowserError(
            'browser_tab_not_found',
            `Browser page ${target.browserPageId} is no longer available`
          )
        }
        const cdpButton = normalizeCdpMouseButton(button)
        const buttons = cdpMouseButtonMask(cdpButton)
        const cdpModifiers = cdpMouseModifierMask(modifiers)
        const lease = acquireElectronDebugger(wc)
        try {
          wc.focus()
          const point =
            cdpButton === 'left'
              ? // Why: DOM activation can't carry Cmd/Ctrl/Alt/Shift, so modifier clicks use the adjusted point and let CDP dispatch the event.
                await resolveMobileTouchClickPoint(wc.debugger, x, y, radius, cdpModifiers === 0)
              : { x, y, adjusted: false, handled: false }
          // Why: land the tap as one atomic op — separate move/down/up CLI calls visibly hover and can miss small controls.
          // Why: mobile-emulated BrowserViews can ignore CDP mouse clicks, so the runtime may already have activated DOM controls.
          if (!point.handled) {
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: point.x,
              y: point.y,
              button: cdpButton,
              buttons,
              modifiers: cdpModifiers,
              clickCount: 1
            })
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: point.x,
              y: point.y,
              button: cdpButton,
              buttons: 0,
              modifiers: cdpModifiers,
              clickCount: 1
            })
          }
          return {
            clicked: {
              x: point.x,
              y: point.y,
              button: cdpButton,
              adjusted: point.adjusted,
              handled: point.handled
            }
          }
        } finally {
          lease.release()
        }
      },
      { ensureSession: false }
    )
  }

  async mouseUp(button?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['mouse', 'up']
      if (button) {
        args.push(button)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async mouseWheel(
    dy: number,
    dx?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['mouse', 'wheel', String(dy)]
      if (dx != null) {
        args.push(String(dx))
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Find (semantic locators) ──

  async find(
    locator: string,
    value: string,
    action: string,
    text?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['find', locator, value, action]
      if (text) {
        args.push(text)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Set commands ──

  async setDevice(name: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'device', name])
    })
  }

  async setOffline(state?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['set', 'offline']
      if (state) {
        args.push(state)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async setHeaders(
    headersJson: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'headers', headersJson])
    })
  }

  async setCredentials(
    user: string,
    pass: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'credentials', user, pass])
    })
  }

  async setMedia(
    colorScheme?: string,
    reducedMotion?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['set', 'media']
      if (colorScheme) {
        args.push(colorScheme)
      }
      if (reducedMotion) {
        args.push(reducedMotion)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }
}
