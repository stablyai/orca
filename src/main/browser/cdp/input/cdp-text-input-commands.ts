import type {
  BrowserClearResult,
  BrowserFillResult,
  BrowserFocusResult,
  BrowserKeypressResult,
  BrowserSelectAllResult,
  BrowserTypeResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { insertTextThroughCdp } from './browser-text-insertion'
import type { CdpBridgeState } from '../commands/cdp-bridge-state'
import type { CdpDebuggerLifecycle } from '../debugger/cdp-debugger-lifecycle'
import type { CdpRefResolution } from '../commands/cdp-ref-resolution'

export class CdpTextInputCommands {
  constructor(
    private readonly bridgeState: CdpBridgeState,
    private readonly debuggerLifecycle: CdpDebuggerLifecycle,
    private readonly refResolution: CdpRefResolution
  ) {}

  fill(element: string, value: string): Promise<BrowserFillResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const node = await this.refResolution.resolveRef(guest, sender, element)
      const refSender = this.refResolution.senderForRef(guest, node)

      await refSender('DOM.focus', { backendNodeId: node.backendDOMNodeId })

      await sender('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })
      await sender('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })
      await sender('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete' })
      await sender('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete' })

      await insertTextThroughCdp(sender, value)

      // Notify controlled inputs in their own frame, where activeElement resolves to the input.
      const eventSender = node.sessionId ? refSender : sender
      await eventSender('Runtime.evaluate', {
        expression: `(() => {
          const el = document.activeElement;
          if (el) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`,
        returnByValue: true
      })

      return { filled: element }
    })
  }

  type(input: string): Promise<BrowserTypeResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      await insertTextThroughCdp(sender, input)
      return { typed: true }
    })
  }

  focus(element: string): Promise<BrowserFocusResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const node = await this.refResolution.resolveRef(guest, sender, element)
      const refSender = this.refResolution.senderForRef(guest, node)
      await refSender('DOM.focus', { backendNodeId: node.backendDOMNodeId })

      return { focused: element }
    })
  }

  clear(element: string): Promise<BrowserClearResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const node = await this.refResolution.resolveRef(guest, sender, element)
      const refSender = this.refResolution.senderForRef(guest, node)

      const { nodeId } = (await refSender('DOM.requestNode', {
        backendNodeId: node.backendDOMNodeId
      })) as { nodeId: number }
      const { object } = (await refSender('DOM.resolveNode', { nodeId })) as {
        object: { objectId: string }
      }

      await refSender('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`
      })

      return { cleared: element }
    })
  }

  selectAll(element: string): Promise<BrowserSelectAllResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const node = await this.refResolution.resolveRef(guest, sender, element)
      const refSender = this.refResolution.senderForRef(guest, node)
      await refSender('DOM.focus', { backendNodeId: node.backendDOMNodeId })

      await sender('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })
      await sender('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })

      return { selected: element }
    })
  }

  keypress(key: string): Promise<BrowserKeypressResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const keyDef = resolveKeyDefinition(key)
      await sender('Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...keyDef
      })
      await sender('Input.dispatchKeyEvent', {
        type: 'keyUp',
        ...keyDef
      })

      return { pressed: key }
    })
  }
}

// CDP needs character text for Enter/Tab default actions.
type KeyDefinition = {
  key: string
  code: string
  windowsVirtualKeyCode?: number
  text?: string
}

const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
}

function resolveKeyDefinition(key: string): KeyDefinition {
  if (KEY_DEFINITIONS[key]) {
    return KEY_DEFINITIONS[key]
  }
  // Sites may reject keys with invalid event.code values.
  if (key.length === 1) {
    const charCode = key.charCodeAt(0)
    if (charCode >= 48 && charCode <= 57) {
      return { key, code: `Digit${key}`, windowsVirtualKeyCode: charCode, text: key }
    }
    if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
      return {
        key,
        code: `Key${key.toUpperCase()}`,
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
        text: key
      }
    }
    return { key, code: '', windowsVirtualKeyCode: charCode, text: key }
  }
  return { key, code: key }
}
