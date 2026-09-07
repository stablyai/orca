import type { WebContents } from 'electron'
import { acquireElectronDebugger } from '../browser/electron-debugger-lease'
import { resolveKeyDefinition } from '../browser/cdp-text-input-commands'
import { cdpMouseButtonMask, normalizeCdpMouseButton } from '../browser/agent-browser-bridge-mouse'
import { Keypress, MouseXY, MouseButton, MouseWheel } from '../runtime/rpc/methods/browser-schemas'

const positions = new WeakMap<
  WebContents,
  WeakMap<WebContents, { x: number; y: number; buttons: number }>
>()
export const WORKSPACE_WINDOW_BROWSER_INPUT_METHODS = new Set([
  'browser.mouseMove',
  'browser.mouseDown',
  'browser.mouseUp',
  'browser.mouseWheel',
  'browser.keypress'
])

export async function dispatchWorkspaceWindowBrowserInput(
  sender: WebContents,
  guest: WebContents,
  method: string,
  params: unknown
): Promise<unknown> {
  const lease = acquireElectronDebugger(guest)
  try {
    if (method === 'browser.keypress') {
      const { key } = Keypress.parse(params)
      const modifierBits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
      let name = key
      let modifiers = 0
      let prefix: RegExpMatchArray | null
      while ((prefix = name.match(/^(Alt|Control|Meta|Shift)\+/))) {
        modifiers |= modifierBits[prefix[1]!]!
        name = name.slice(prefix[0].length)
      }
      const definition = resolveKeyDefinition(name)
      const event = {
        ...definition,
        modifiers,
        ...((modifiers & 7) !== 0 ? { text: undefined } : {})
      }
      await guest.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event })
      await guest.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
      return { pressed: key }
    }
    let senderPositions = positions.get(sender)
    if (!senderPositions) {
      senderPositions = new WeakMap()
      positions.set(sender, senderPositions)
    }
    let position = senderPositions.get(guest) ?? { x: 0, y: 0, buttons: 0 }
    if (method === 'browser.mouseMove') {
      const { x, y } = MouseXY.parse(params)
      position = { ...position, x, y }
      senderPositions.set(guest, position)
      await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        ...position
      })
    } else if (method === 'browser.mouseWheel') {
      const { dx, dy } = MouseWheel.parse(params)
      await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...position,
        deltaX: dx ?? 0,
        deltaY: dy
      })
    } else {
      const button = normalizeCdpMouseButton(MouseButton.parse(params).button)
      const pressed = method === 'browser.mouseDown'
      position = {
        ...position,
        buttons: pressed
          ? position.buttons | cdpMouseButtonMask(button)
          : position.buttons & ~cdpMouseButtonMask(button)
      }
      senderPositions.set(guest, position)
      await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: pressed ? 'mousePressed' : 'mouseReleased',
        ...position,
        button,
        clickCount: 1
      })
    }
    return { ok: true }
  } finally {
    lease.release()
  }
}
