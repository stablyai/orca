/**
 * Holds a page's keys while main asks the page whether a field has focus, then gives them back in order.
 * Why: main must decide at `before-input-event` whether a bare letter is a tool key, and a preventDefault there can't
 * be undone later. When main's last report says "no field" but focus may just have moved (page script, Tab), taking
 * the letter could swallow typing. So the letter and every key after it wait for one direct answer from the page:
 * a field has focus -> all held keys go back to the page in order; no field -> the letter is a tool key and the keys
 * after it go back through the normal path in order. No answer in time counts as "a field" (keys go to the page).
 */
import type { WebContents } from 'electron'

/** Longest a held key waits for the page's answer before going back to it. */
export const GUEST_KEY_HOLD_MS = 150

export type HeldKeyInput = Pick<
  Electron.Input,
  'type' | 'key' | 'code' | 'shift' | 'control' | 'alt' | 'meta' | 'isAutoRepeat' | 'isComposing'
>
type KeyInput = HeldKeyInput

// Electron's sendInputEvent names some keys differently from KeyboardEvent.key.
const SEND_KEY_CODE: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down'
}

function modifiersOf(input: KeyInput): ('shift' | 'control' | 'alt' | 'meta' | 'isautorepeat')[] {
  const modifiers: ('shift' | 'control' | 'alt' | 'meta' | 'isautorepeat')[] = []
  if (input.shift) {
    modifiers.push('shift')
  }
  if (input.control) {
    modifiers.push('control')
  }
  if (input.alt) {
    modifiers.push('alt')
  }
  if (input.meta) {
    modifiers.push('meta')
  }
  if (input.isAutoRepeat) {
    modifiers.push('isautorepeat')
  }
  return modifiers
}

/** Sends one held key back into the page as it was pressed, typing its character on key-down. */
export function replayKey(guest: Pick<WebContents, 'sendInputEvent'>, input: KeyInput): void {
  const keyCode = SEND_KEY_CODE[input.key] ?? input.key
  const modifiers = modifiersOf(input)
  if (input.type === 'keyUp') {
    guest.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    return
  }
  guest.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  // A printable key types its character; without this the page would get the key but no text.
  if ([...input.key].length === 1 && !input.control && !input.meta) {
    guest.sendInputEvent({ type: 'char', keyCode: input.key, modifiers })
  }
}

export class GuestKeyHold {
  private held: KeyInput[] | null = null
  // Keys this hold sends back pass through the page's handler once without being held or taken again.
  private replaying = 0
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly guest: Pick<WebContents, 'sendInputEvent' | 'isDestroyed'>,
    private readonly askPageHasField: () => Promise<boolean>,
    /** True for a bare tool-letter key-down (what main takes as a tool key off a field). */
    private readonly isToolKeyDown: (input: KeyInput) => boolean,
    private readonly takeAsTool: (input: KeyInput) => void
  ) {}

  /** True while keys are being held; the caller must prevent and pass every key here meanwhile. */
  get holding(): boolean {
    return this.held !== null
  }

  /** True for a key this hold itself sent back; the caller lets it through untouched. */
  consumeReplay(): boolean {
    if (this.replaying === 0) {
      return false
    }
    this.replaying -= 1
    return true
  }

  /** Starts holding at a letter main would take as a tool key. */
  start(letter: KeyInput): void {
    this.release()
    const generation = ++this.generation
    this.held = [letter]
    let settled = false
    const settle = (pageHasField: boolean): void => {
      if (settled || this.generation !== generation) {
        return
      }
      settled = true
      this.finish(pageHasField)
    }
    const timer = setTimeout(() => settle(true), GUEST_KEY_HOLD_MS)
    this.timer = timer
    this.askPageHasField().then(
      (hasField) => {
        clearTimeout(timer)
        settle(hasField)
      },
      () => {
        clearTimeout(timer)
        settle(true)
      }
    )
  }

  /** A key that arrived while holding; it waits its turn behind the held letter. */
  add(input: KeyInput): void {
    this.held?.push(input)
  }

  /** The pick ended or the page is going away: held keys go back to the page as typed. */
  release(): void {
    if (this.held) {
      this.finish(true)
    }
  }

  /** Navigation/disposal invalidates input for the old document; it must never reach a replacement document. */
  discard(): void {
    this.generation += 1
    clearTimeout(this.timer)
    this.held = null
    this.replaying = 0
  }

  private finish(pageHasField: boolean): void {
    this.generation += 1
    clearTimeout(this.timer)
    const held = this.held ?? []
    this.held = null
    if (this.guest.isDestroyed()) {
      return
    }
    if (pageHasField) {
      for (const input of held) {
        this.sendBack(input)
      }
      return
    }
    // No field: tool letters act as tools, everything else (key-ups, other keys) goes back to the page, in order.
    for (const input of held) {
      if (this.isToolKeyDown(input)) {
        this.takeAsTool(input)
      } else {
        this.sendBack(input)
      }
    }
  }

  private sendBack(input: KeyInput): void {
    // Key-down plus its character are two inputs, but only the key-down reaches before-input-event.
    this.replaying += 1
    replayKey(this.guest, input)
  }
}
