import type { KeyboardInputEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import {
  DIGIT_INDEX_ACTION_IDS,
  KEYBINDING_DEFINITIONS,
  keybindingMatchesAction,
  matchKeybindingDigitIndex,
  type KeybindingInput,
  type KeybindingOverrides,
  type TerminalShortcutPolicy
} from '../../shared/keybindings'
import { buildNativeTerminalForwardedChords } from '../../shared/native-terminal-forwarded-chords'
import { matchesRecentTabSwitcherChord } from '../../shared/window-shortcut-policy'
import { toKeyboardInputEvents } from './ghostty-forwarded-key'

const COMMAND = 1 << 20
const SHIFT = 1 << 17

describe('toKeyboardInputEvents', () => {
  it('replays a command chord as a keyDown/keyUp pair', () => {
    expect(
      toKeyboardInputEvents({
        characters: 't',
        keyCode: 0x11,
        modifierFlags: COMMAND,
        isRepeat: false
      })
    ).toEqual([
      { type: 'keyDown', keyCode: 'T', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'T', modifiers: ['meta'] }
    ])
  })

  it('keeps the physical key and reports shift as a modifier', () => {
    const [down] = toKeyboardInputEvents({
      characters: '[',
      keyCode: 0x21,
      modifierFlags: COMMAND | SHIFT,
      isRepeat: false
    })
    expect(down).toEqual({ type: 'keyDown', keyCode: '[', modifiers: ['shift', 'meta'] })
  })

  it('names special keys by their accelerator', () => {
    const [down] = toKeyboardInputEvents({
      characters: '',
      keyCode: 0x7b,
      modifierFlags: COMMAND,
      isRepeat: true
    })
    expect(down).toEqual({ type: 'keyDown', keyCode: 'Left', modifiers: ['meta', 'isautorepeat'] })
  })

  it('drops events with no usable key', () => {
    expect(
      toKeyboardInputEvents({
        characters: '',
        keyCode: 0x3f,
        modifierFlags: COMMAND,
        isRepeat: false
      })
    ).toEqual([])
  })
})

// What Chromium makes of a replayed accelerator: the DOM key/code Orca's handlers match against.
function toDomInput(event: KeyboardInputEvent): KeybindingInput {
  const modifiers = new Set(event.modifiers)
  const shift = modifiers.has('shift')
  const accelerator = event.keyCode
  const arrows: Record<string, string> = {
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown'
  }
  const punctuationCodes: Record<string, string> = {
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '-': 'Minus',
    '=': 'Equal',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote'
  }
  let key = arrows[accelerator] ?? accelerator
  let code = key
  if (/^[A-Z]$/.test(accelerator)) {
    key = shift ? accelerator : accelerator.toLowerCase()
    code = `Key${accelerator}`
  } else if (/^[0-9]$/.test(accelerator)) {
    code = `Digit${accelerator}`
  } else if (punctuationCodes[accelerator]) {
    code = punctuationCodes[accelerator]
  } else if (accelerator === 'Space') {
    key = ' '
  }
  return {
    key,
    code,
    shiftKey: shift,
    ctrlKey: modifiers.has('control'),
    altKey: modifiers.has('alt'),
    metaKey: modifiers.has('meta')
  }
}

function orcaClaimsInTerminal(
  input: KeybindingInput,
  overrides: KeybindingOverrides | undefined,
  terminalShortcutPolicy: TerminalShortcutPolicy
): boolean {
  const options = { context: 'terminal', terminalShortcutPolicy } as const
  return (
    KEYBINDING_DEFINITIONS.some((definition) =>
      keybindingMatchesAction(definition.id, input, 'darwin', overrides, options)
    ) ||
    matchesRecentTabSwitcherChord(input, 'darwin', overrides, options) ||
    DIGIT_INDEX_ACTION_IDS.some(
      (actionId) =>
        matchKeybindingDigitIndex(actionId, input, 'darwin', overrides, options) !== null
    )
  )
}

describe('forwarded chord replay', () => {
  it('replays a modifier release as a lone keyup', () => {
    expect(
      toKeyboardInputEvents({
        characters: '',
        keyCode: 0x3b,
        modifierFlags: 0,
        isRepeat: false,
        isRelease: true
      })
    ).toEqual([{ type: 'keyUp', keyCode: 'Control', modifiers: [] }])
  })

  it.each([
    ['defaults, orca-first', undefined, 'orca-first'],
    ['defaults, terminal-first', undefined, 'terminal-first'],
    [
      'user bindings',
      {
        'terminal.focusPreviousPane': ['Ctrl+Alt+H'],
        'terminal.focusNextPane': ['Ctrl+Alt+ArrowLeft', 'Ctrl+Shift+BracketRight'],
        'terminal.search': ['Alt+F3']
      },
      'orca-first'
    ]
  ] satisfies [string, KeybindingOverrides | undefined, TerminalShortcutPolicy][])(
    'turns every %s chord into input Orca claims over a terminal',
    (_label, overrides, terminalShortcutPolicy) => {
      const chords = buildNativeTerminalForwardedChords({ overrides, terminalShortcutPolicy })
      expect(chords.length).toBeGreaterThan(0)
      for (const chord of chords) {
        const [down] = toKeyboardInputEvents({
          characters: chord.character,
          keyCode: chord.keyCode,
          modifierFlags: chord.modifierFlags,
          isRepeat: false
        })
        expect(down, JSON.stringify(chord)).toBeDefined()
        expect(
          orcaClaimsInTerminal(toDomInput(down), overrides, terminalShortcutPolicy),
          JSON.stringify(chord)
        ).toBe(true)
      }
    }
  )
})
