import type { BrowserMouseModifier } from './agent-browser-bridge-types'
import { BrowserError } from './cdp-bridge'
import {
  normalizeCdpMouseButton,
  cdpPointerButtonMask,
  cdpMouseModifierMask,
  resolveMobileTouchClickPoint
} from './agent-browser-bridge-mouse'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { assertRemoteCliBrowserAccess } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { AgentBrowserBridgePointerCommands } from './agent-browser-bridge-pointer-commands'
import { agentBrowserSetMediaArguments } from './agent-browser-set-media-arguments'

export abstract class AgentBrowserBridgeMouseCommands extends AgentBrowserBridgePointerCommands {
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
        const buttons = cdpPointerButtonMask(cdpButton)
        const cdpModifiers = cdpMouseModifierMask(modifiers)
        const lease = acquireElectronDebugger(wc)
        let releaseFocusGuard = (): void => {}
        try {
          await this.waitForPagePaint(wc, target.webContentsId)
          await this.browserManager.showAgentPointer(wc, { type: 'mouseMoved', x, y })
          releaseFocusGuard = await this.focusPageForPress(wc, target.webContentsId)
          // Hit testing can activate an element; recheck access after awaiting focus.
          assertRemoteCliBrowserAccess(target.webContentsId)
          const point =
            cdpButton === 'left'
              ? // DOM activation drops modifiers; let CDP dispatch modifier clicks.
                await resolveMobileTouchClickPoint(wc.debugger, x, y, radius, cdpModifiers === 0)
              : { x, y, adjusted: false, handled: false }
          // Mobile-emulated guests can ignore CDP clicks, so hit testing may already activate the control.
          await this.browserManager.showAgentPointer(wc, {
            type: 'mousePressed',
            x: point.x,
            y: point.y
          })
          if (!point.handled) {
            await sendGuestCdpCommand(wc, 'Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: point.x,
              y: point.y,
              button: cdpButton,
              buttons,
              modifiers: cdpModifiers,
              clickCount: 1
            })
            await sendGuestCdpCommand(wc, 'Input.dispatchMouseEvent', {
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
          releaseFocusGuard()
          lease.release()
        }
      },
      { ensureSession: false }
    )
  }

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
    const args = agentBrowserSetMediaArguments(colorScheme, reducedMotion)
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, args)
    })
  }
}
