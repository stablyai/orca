import type { WebContents } from 'electron'
import type { OffscreenPageUserInput } from '../../shared/offscreen-page-protocol'
import type { OffscreenPageCdpSession } from './offscreen-page-cdp-session'
import type { OffscreenPageFrames } from './offscreen-page-frames'
import { macKeyEditingCommands } from './offscreen-page-mac-key-commands'

type Modifier = 'shift' | 'control' | 'alt' | 'meta'
type HeldButton = 'left' | 'middle' | 'right'

const CDP_MODIFIER_BITS: Record<Modifier, number> = { alt: 1, control: 2, meta: 4, shift: 8 }
const HELD_BUTTON_MODIFIERS: Record<
  HeldButton,
  'leftbuttondown' | 'middlebuttondown' | 'rightbuttondown'
> = {
  left: 'leftbuttondown',
  middle: 'middlebuttondown',
  right: 'rightbuttondown'
}

// Why CDP for the mouse: it can address an out-of-process iframe's own target; Electron's
// offscreen sendInputEvent hands every mouse event to the main frame.
const CDP_MOUSE_TYPES: Partial<Record<string, string>> = {
  mouseDown: 'mousePressed',
  mouseUp: 'mouseReleased',
  mouseMove: 'mouseMoved',
  mouseEnter: 'mouseMoved'
}
const HELD_BUTTON_BITS: Record<HeldButton, number> = { left: 1, right: 2, middle: 4 }
const SIDE_BUTTON_BITS: Partial<Record<string, number>> = { back: 8, forward: 16 }

/**
 * Sends a mouse event the way Electron's offscreen view takes it natively: only this reaches the
 * page's own popups (the datalist suggestions), and it is the one route for leaving the page.
 */
export function sendOffscreenPageMouse(
  target: WebContents,
  input: Extract<OffscreenPageUserInput, { kind: 'mouse' }>
): void {
  if (input.button === 'back' || input.button === 'forward') {
    return
  }
  target.sendInputEvent({
    type: input.type,
    x: Math.round(input.x),
    y: Math.round(input.y),
    button: input.button,
    clickCount: input.clickCount,
    modifiers: [...input.modifiers, ...input.heldButtons.map((b) => HELD_BUTTON_MODIFIERS[b])]
  })
}

/**
 * Replays one user input event into an offscreen page, in the order it came. Mouse, keys and IME
 * go through the page's CDP session, which reaches out-of-process iframes and carries each key's
 * real code, location and, on macOS, the key-binding editing commands a native key press has.
 * Wheel goes through sendInputEvent, which Electron already routes.
 * Neither path can move the host window's focus: an offscreen page has no native view.
 */
export async function dispatchOffscreenPageUserInput(
  target: WebContents,
  cdp: { session: OffscreenPageCdpSession; frames: OffscreenPageFrames },
  input: OffscreenPageUserInput,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (target.isDestroyed()) {
    return
  }
  const { session, frames } = cdp
  const send = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    frames.inOrder(() => ({ reply: session.send(method, params) }))
  switch (input.kind) {
    case 'mouse': {
      const type = CDP_MOUSE_TYPES[input.type]
      if (!type) {
        await frames.leave()
        sendOffscreenPageMouse(target, input)
        return
      }
      const pressed = input.type === 'mouseDown' ? (SIDE_BUTTON_BITS[input.button] ?? 0) : 0
      // CDP takes CSS px; page zoom scales them to the DIPs the input came in.
      const zoom = target.getZoomFactor()
      const sent = await frames.sendMouse({
        type,
        x: input.x / zoom,
        y: input.y / zoom,
        button: type === 'mouseMoved' ? (input.heldButtons[0] ?? 'none') : input.button,
        buttons: input.heldButtons.reduce((mask, b) => mask | HELD_BUTTON_BITS[b], pressed),
        clickCount: input.clickCount,
        modifiers: modifierMask(input.modifiers)
      })
      if (sent === undefined && !target.isDestroyed() && !(input.button in SIDE_BUTTON_BITS)) {
        sendOffscreenPageMouse(target, input)
      }
      return
    }
    case 'wheel':
      target.sendInputEvent(electronWheelEvent(input))
      return
    case 'key': {
      const keyDown = input.type === 'keyDown'
      const commands =
        keyDown && platform === 'darwin' ? macKeyEditingCommands(input.code, input.modifiers) : []
      const sent = await send('Input.dispatchKeyEvent', {
        type: keyDown ? (input.text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
        modifiers: modifierMask(input.modifiers),
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: input.keyCode,
        nativeVirtualKeyCode: input.keyCode,
        autoRepeat: input.repeat,
        location: input.location,
        isKeypad: input.location === 3,
        ...(keyDown && input.text ? { text: input.text, unmodifiedText: input.text } : {}),
        ...(commands.length > 0 ? { commands } : {})
      })
      if (sent === undefined && !target.isDestroyed()) {
        // Why: typing must survive losing the debugger; sendInputEvent only lacks code and commands.
        const modifiers = [...input.modifiers]
        target.sendInputEvent({
          type: keyDown ? 'keyDown' : 'keyUp',
          keyCode: input.key,
          modifiers
        })
        if (keyDown && input.text) {
          target.sendInputEvent({ type: 'char', keyCode: input.text, modifiers })
        }
      }
      return
    }
    case 'compose':
      await send('Input.imeSetComposition', {
        text: input.text,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd
      })
      return
    case 'commit':
      await send('Input.insertText', { text: input.text })
      return
    case 'cancelComposition':
      // Why: an empty composition clears the page's underlined preedit without inserting text.
      await send('Input.imeSetComposition', {
        text: '',
        selectionStart: 0,
        selectionEnd: 0
      })
  }
}

/** The wheel as Electron's input event, which is how both the page and viewport panning take it. */
export function electronWheelEvent(
  input: Extract<OffscreenPageUserInput, { kind: 'wheel' }>
): Electron.MouseWheelInputEvent {
  return {
    type: 'mouseWheel',
    x: Math.round(input.x),
    y: Math.round(input.y),
    deltaX: input.deltaX,
    deltaY: input.deltaY,
    modifiers: input.modifiers
  }
}

/** The key in the shape a <webview>'s before-input-event carries, for Orca's shortcut matching. */
export function electronKeyInput(
  input: Extract<OffscreenPageUserInput, { kind: 'key' }>
): Pick<
  Electron.Input,
  'type' | 'key' | 'code' | 'meta' | 'control' | 'alt' | 'shift' | 'isAutoRepeat'
> {
  return {
    type: input.type,
    key: input.key,
    code: input.code,
    meta: input.modifiers.includes('meta'),
    control: input.modifiers.includes('control'),
    alt: input.modifiers.includes('alt'),
    shift: input.modifiers.includes('shift'),
    isAutoRepeat: input.repeat
  }
}

function modifierMask(modifiers: readonly Modifier[]): number {
  return modifiers.reduce((mask, modifier) => mask | CDP_MODIFIER_BITS[modifier], 0)
}
