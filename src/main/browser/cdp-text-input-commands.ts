import type {
  BrowserClearResult,
  BrowserFillResult,
  BrowserFocusResult,
  BrowserKeypressResult,
  BrowserSelectAllResult,
  BrowserTypeResult
} from '../../shared/runtime-types'
import { insertTextThroughCdp } from './browser-text-insertion'
import { CdpBridgeCommandModule } from './cdp-bridge-command-module'

export class CdpTextInputCommands extends CdpBridgeCommandModule {
  fill(element: string, value: string): Promise<BrowserFillResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)

      await refSender('DOM.focus', { backendNodeId: node.backendDOMNodeId })

      // Why: select-all + delete clears the existing value before typing, matching Playwright/agent-browser fill().
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

      // Why: React's synthetic listeners ignore native key events, so dispatch input/change so controlled components update.
      // Why: use refSender for iframe sessions so document.activeElement is the focused element inside the iframe, not the parent <iframe>.
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
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await insertTextThroughCdp(sender, input)
      return { typed: true }
    })
  }

  focus(element: string): Promise<BrowserFocusResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
      await refSender('DOM.focus', { backendNodeId: node.backendDOMNodeId })

      return { focused: element }
    })
  }

  clear(element: string): Promise<BrowserClearResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)

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
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
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
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

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

// Why: Input.dispatchKeyEvent needs `text` for keys with default actions (Enter/Tab), or Chrome skips the action.
export type KeyDefinition = {
  key: string
  code: string
  modifiers?: number
  windowsVirtualKeyCode?: number
  text?: string
  unmodifiedText?: string
}

const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  Backquote: { key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, text: '`' },
  Minus: { key: '-', code: 'Minus', windowsVirtualKeyCode: 189, text: '-' },
  Equal: { key: '=', code: 'Equal', windowsVirtualKeyCode: 187, text: '=' },
  Backslash: { key: '\\', code: 'Backslash', windowsVirtualKeyCode: 220, text: '\\' },
  BracketLeft: { key: '[', code: 'BracketLeft', windowsVirtualKeyCode: 219, text: '[' },
  BracketRight: { key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221, text: ']' },
  Semicolon: { key: ';', code: 'Semicolon', windowsVirtualKeyCode: 186, text: ';' },
  Quote: { key: "'", code: 'Quote', windowsVirtualKeyCode: 222, text: "'" },
  Comma: { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, text: ',' },
  Period: { key: '.', code: 'Period', windowsVirtualKeyCode: 190, text: '.' },
  Slash: { key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' },
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
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => {
      const key = `F${index + 1}`
      return [key, { key, code: key, windowsVirtualKeyCode: 112 + index }]
    })
  )
}

const SHIFTED_KEYS: Record<string, string> = {
  Backquote: '~',
  Minus: '_',
  Equal: '+',
  Backslash: '|',
  BracketLeft: '{',
  BracketRight: '}',
  Semicolon: ':',
  Quote: '"',
  Comma: '<',
  Period: '>',
  Slash: '?'
}

const SHIFTED_DIGITS = ')!@#$%^&*('

const PUNCTUATION_KEYS: Record<
  string,
  { code: string; windowsVirtualKeyCode: number; shifted: string }
> = {
  '`': { code: 'Backquote', windowsVirtualKeyCode: 192, shifted: '~' },
  '-': { code: 'Minus', windowsVirtualKeyCode: 189, shifted: '_' },
  '=': { code: 'Equal', windowsVirtualKeyCode: 187, shifted: '+' },
  '\\': { code: 'Backslash', windowsVirtualKeyCode: 220, shifted: '|' },
  '[': { code: 'BracketLeft', windowsVirtualKeyCode: 219, shifted: '{' },
  ']': { code: 'BracketRight', windowsVirtualKeyCode: 221, shifted: '}' },
  ';': { code: 'Semicolon', windowsVirtualKeyCode: 186, shifted: ':' },
  "'": { code: 'Quote', windowsVirtualKeyCode: 222, shifted: '"' },
  ',': { code: 'Comma', windowsVirtualKeyCode: 188, shifted: '<' },
  '.': { code: 'Period', windowsVirtualKeyCode: 190, shifted: '>' },
  '/': { code: 'Slash', windowsVirtualKeyCode: 191, shifted: '?' }
}

export function resolveKeyDefinition(input: string): KeyDefinition {
  const parts = input.split('+')
  let key = parts.pop() ?? input
  if (key === '' && parts.at(-1) === '') {
    parts.pop()
    key = '+'
  }
  let modifiers = 0
  for (const modifier of parts) {
    if (modifier === 'Alt') {
      modifiers |= 1
    } else if (modifier === 'Control' || modifier === 'Ctrl') {
      modifiers |= 2
    } else if (
      modifier === 'Meta' ||
      modifier === 'Command' ||
      modifier === 'Cmd' ||
      (modifier === 'ControlOrMeta' && process.platform === 'darwin')
    ) {
      modifiers |= 4
    } else if (modifier === 'ControlOrMeta') {
      modifiers |= 2
    } else if (modifier === 'Shift') {
      modifiers |= 8
    }
  }

  const hasNonShiftModifier = (modifiers & ~8) !== 0

  if (KEY_DEFINITIONS[key]) {
    if (modifiers === 0) {
      return KEY_DEFINITIONS[key]
    }
    const baseDefinition = KEY_DEFINITIONS[key]
    const shiftedKey = (modifiers & 8) !== 0 ? SHIFTED_KEYS[key] : undefined
    return {
      ...baseDefinition,
      ...(shiftedKey
        ? {
            key: shiftedKey,
            text: hasNonShiftModifier ? undefined : shiftedKey,
            unmodifiedText: shiftedKey
          }
        : {}),
      modifiers,
      ...(hasNonShiftModifier ? { text: undefined } : {})
    }
  }
  // Why: sites that check event.code drop events with invalid code values.
  if (key.length === 1) {
    const charCode = key.charCodeAt(0)
    if (charCode >= 48 && charCode <= 57) {
      const shiftedKey = (modifiers & 8) !== 0 ? SHIFTED_DIGITS[Number(key)] : key
      return {
        key: shiftedKey,
        code: `Digit${key}`,
        windowsVirtualKeyCode: charCode,
        ...(hasNonShiftModifier ? {} : { text: shiftedKey }),
        modifiers,
        ...(modifiers > 0 ? { unmodifiedText: (modifiers & 8) !== 0 ? shiftedKey : key } : {})
      }
    }
    if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
      const text = hasNonShiftModifier ? undefined : key
      const shiftedKey = (modifiers & 8) !== 0 ? key.toUpperCase() : key
      return {
        key: shiftedKey,
        code: `Key${shiftedKey.toUpperCase()}`,
        windowsVirtualKeyCode: shiftedKey.toUpperCase().charCodeAt(0),
        ...(text !== undefined ? { text: (modifiers & 8) !== 0 ? shiftedKey : text } : {}),
        ...(modifiers > 0 ? { unmodifiedText: (modifiers & 8) !== 0 ? shiftedKey : key } : {}),
        modifiers
      }
    }
    const punctuation = PUNCTUATION_KEYS[key]
    if (punctuation) {
      const shiftedKey = (modifiers & 8) !== 0 ? punctuation.shifted : key
      return {
        key: shiftedKey,
        code: punctuation.code,
        windowsVirtualKeyCode: punctuation.windowsVirtualKeyCode,
        ...(hasNonShiftModifier ? {} : { text: shiftedKey }),
        modifiers,
        ...(modifiers > 0 ? { unmodifiedText: (modifiers & 8) !== 0 ? shiftedKey : key } : {})
      }
    }
    return {
      key,
      code: '',
      windowsVirtualKeyCode: charCode,
      text: key,
      modifiers,
      ...(modifiers > 0 ? { unmodifiedText: key } : {})
    }
  }
  return { key, code: key, modifiers }
}
