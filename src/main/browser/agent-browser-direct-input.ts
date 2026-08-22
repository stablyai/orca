import type { WebContents } from 'electron'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { resolveCdpKeypressDefinition } from './cdp-keypress'

type CdpMouseButton = 'left' | 'middle' | 'right'

type PointerState = {
  x: number
  y: number
  buttons: number
}

function normalizeButton(button?: string): CdpMouseButton {
  return button === 'middle' || button === 'right' ? button : 'left'
}

function buttonMask(button: CdpMouseButton): number {
  if (button === 'right') {
    return 2
  }
  if (button === 'middle') {
    return 4
  }
  return 1
}

export class AgentBrowserDirectInput {
  private readonly pointerByPage = new Map<string, PointerState>()
  private readonly tokenByPage = new Map<string, object>()

  forget(browserPageId: string): void {
    this.pointerByPage.delete(browserPageId)
    this.tokenByPage.delete(browserPageId)
  }

  capturePageToken(browserPageId: string): object {
    const current = this.tokenByPage.get(browserPageId)
    if (current) {
      return current
    }
    const token = {}
    this.tokenByPage.set(browserPageId, token)
    return token
  }

  recordPointer(browserPageId: string, x: number, y: number, token?: object): void {
    if (token && this.tokenByPage.get(browserPageId) !== token) {
      return
    }
    this.pointerByPage.set(browserPageId, { x, y, buttons: 0 })
  }

  async move(browserPageId: string, wc: WebContents, x: number, y: number): Promise<unknown> {
    const token = this.capturePageToken(browserPageId)
    const previous = this.pointerByPage.get(browserPageId)
    const state = { x, y, buttons: previous?.buttons ?? 0 }
    await this.withDebugger(wc, () =>
      wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...state })
    )
    this.setPointerIfCurrent(browserPageId, token, state)
    return { moved: { x, y } }
  }

  async down(browserPageId: string, wc: WebContents, button?: string): Promise<unknown> {
    const token = this.capturePageToken(browserPageId)
    const cdpButton = normalizeButton(button)
    const previous = this.pointerByPage.get(browserPageId) ?? { x: 0, y: 0, buttons: 0 }
    const state = { ...previous, buttons: previous.buttons | buttonMask(cdpButton) }
    await this.withDebugger(wc, () =>
      wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...state,
        button: cdpButton,
        clickCount: 1
      })
    )
    this.setPointerIfCurrent(browserPageId, token, state)
    return { pressed: cdpButton }
  }

  async up(browserPageId: string, wc: WebContents, button?: string): Promise<unknown> {
    const token = this.capturePageToken(browserPageId)
    const cdpButton = normalizeButton(button)
    const previous = this.pointerByPage.get(browserPageId) ?? { x: 0, y: 0, buttons: 0 }
    const state = { ...previous, buttons: previous.buttons & ~buttonMask(cdpButton) }
    await this.withDebugger(wc, () =>
      wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...state,
        button: cdpButton,
        clickCount: 1
      })
    )
    this.setPointerIfCurrent(browserPageId, token, state)
    return { released: cdpButton }
  }

  async wheel(browserPageId: string, wc: WebContents, dy: number, dx = 0): Promise<unknown> {
    const state = this.pointerByPage.get(browserPageId) ?? { x: 0, y: 0, buttons: 0 }
    await this.withDebugger(wc, () =>
      wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...state,
        deltaX: dx,
        deltaY: dy
      })
    )
    return { scrolled: { dx, dy } }
  }

  async keypress(wc: WebContents, key: string): Promise<unknown> {
    const definition = resolveCdpKeypressDefinition(key)
    await this.withDebugger(wc, async () => {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...definition })
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...definition })
    })
    return { pressed: key }
  }

  private async withDebugger(wc: WebContents, run: () => Promise<unknown>): Promise<void> {
    const lease = acquireElectronDebugger(wc)
    try {
      wc.focus()
      await run()
    } finally {
      lease.release()
    }
  }

  private setPointerIfCurrent(browserPageId: string, token: object, state: PointerState): void {
    if (this.tokenByPage.get(browserPageId) === token) {
      this.pointerByPage.set(browserPageId, state)
    }
  }
}
