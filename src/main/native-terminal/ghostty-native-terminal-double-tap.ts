import type { BrowserWindow, KeyboardInputEvent } from 'electron'
import type { PhysicalModifierToken } from '../../shared/keybindings'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../shared/modifier-double-tap-detector'
import { NS_COMMAND, NS_CONTROL, NS_OPTION, NS_SHIFT } from '../../shared/native-terminal-keys'

// DOM `code` for each modifier key (Carbon kVK_*), the names Orca's detector reads.
const MODIFIER_CODES: Readonly<Record<number, string>> = {
  0x38: 'ShiftLeft',
  0x3c: 'ShiftRight',
  0x3b: 'ControlLeft',
  0x3e: 'ControlRight',
  0x3a: 'AltLeft',
  0x3d: 'AltRight',
  0x37: 'MetaLeft',
  0x36: 'MetaRight'
}

const REPLAY_KEYS = {
  Shift: { keyCode: 'Shift', modifier: 'shift' },
  Ctrl: { keyCode: 'Control', modifier: 'control' },
  Alt: { keyCode: 'Alt', modifier: 'alt' },
  Cmd: { keyCode: 'Meta', modifier: 'meta' }
} as const satisfies Record<PhysicalModifierToken, unknown>

export type NativeDoubleTapInput = {
  keyCode: number
  modifierFlags: number
  phase: 'press' | 'release' | 'other'
}

// Two clean taps, which Orca's own detectors (main and renderer) recognise as the gesture.
export function replayDoubleTap(modifier: PhysicalModifierToken): KeyboardInputEvent[] {
  const { keyCode, modifier: flag } = REPLAY_KEYS[modifier]
  const press: KeyboardInputEvent = { type: 'keyDown', keyCode, modifiers: [flag] }
  const release: KeyboardInputEvent = { type: 'keyUp', keyCode, modifiers: [] }
  return [press, release, press, release]
}

// Orca's double-tap detectors read DOM key events, which keys Ghostty takes never become: run
// the same detector over the native stream and replay a clean double tap when it fires.
export class NativeDoubleTapRelay {
  private readonly detector = new ModifierDoubleTapDetector()

  process(input: NativeDoubleTapInput, nowMs: number): KeyboardInputEvent[] {
    const detected = this.detector.process(
      toModifierDoubleTapEvent({
        type: input.phase === 'release' ? 'keyUp' : 'keyDown',
        code: input.phase === 'other' ? undefined : MODIFIER_CODES[input.keyCode],
        shift: (input.modifierFlags & NS_SHIFT) !== 0,
        control: (input.modifierFlags & NS_CONTROL) !== 0,
        alt: (input.modifierFlags & NS_OPTION) !== 0,
        meta: (input.modifierFlags & NS_COMMAND) !== 0
      }),
      nowMs
    )
    return detected ? replayDoubleTap(detected.modifier) : []
  }
}

const relays = new WeakMap<BrowserWindow, NativeDoubleTapRelay>()

// args: [keyCode, modifierFlags, phase] as the addon reports them (0 press, 1 release, 2 other).
export function relayNativeDoubleTapInput(
  window: BrowserWindow,
  args: unknown[]
): KeyboardInputEvent[] {
  let relay = relays.get(window)
  if (!relay) {
    relay = new NativeDoubleTapRelay()
    relays.set(window, relay)
  }
  const phase = Number(args[2])
  return relay.process(
    {
      keyCode: Number(args[0]),
      modifierFlags: Number(args[1]),
      phase: phase === 0 ? 'press' : phase === 1 ? 'release' : 'other'
    },
    Date.now()
  )
}
