import { describe, expect, it } from 'vitest'
import { mapTerminalLiveHardwareKeyEvent } from './terminal-live-hardware-key-mapping'

describe('terminal live hardware key mapping', () => {
  it('Given Meta modifiers When mapped Then ignores the event (system-owned)', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'c',
          modifiers: { ctrl: false, alt: false, shift: false, meta: true },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'ignore' })
  })

  it('Given plain printable When mapped Then ignores so TextInput owns typing', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'a',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'ignore' })
  })

  it('Given Shift+printable When mapped Then ignores so TextInput owns typing', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'A',
          modifiers: { ctrl: false, alt: false, shift: true, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'ignore' })
  })

  it('Given Option+printable When mapped Then ignores so TextInput owns accented input', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'e',
          modifiers: { ctrl: false, alt: true, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'ignore' })
  })

  it('Given ArrowLeft with empty field When mapped Then sends CSI left', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'ArrowLeft',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'send-bytes', bytes: '\x1b[D' })
  })

  it('Given Tab When mapped Then sends tab byte', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'Tab',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'send-bytes', bytes: '\t' })
  })

  it('Given Shift+Tab When mapped Then sends reverse-tab bytes', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'Tab',
          modifiers: { ctrl: false, alt: false, shift: true, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'send-bytes', bytes: '\x1b[Z' })
  })

  it('Given Shift+ArrowLeft When mapped Then preserves the modifier in CSI bytes', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'ArrowLeft',
          modifiers: { ctrl: false, alt: false, shift: true, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'send-bytes', bytes: '\x1b[1;2D' })
  })

  it('Given Escape When mapped Then sends ESC', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'Escape',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'send-bytes', bytes: '\x1b' })
  })

  it('Given F5 When mapped Then sends CSI function sequence', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'F5',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'send-bytes', bytes: '\x1b[15~' })
  })

  it('Given Ctrl+C When mapped Then sends ETX interrupt byte', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'c',
          modifiers: { ctrl: true, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'send-bytes', bytes: '\x03' })
  })

  it('Given Ctrl+Alt+Space When mapped Then preserves the input-method shortcut', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: ' ',
          modifiers: { ctrl: true, alt: true, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'ignore' })
  })

  it('Given Backspace with field text When mapped Then local-edits via accessory backspace', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'Backspace',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: 'ab' }
      )
    ).toEqual({ kind: 'local-edit', localEdit: 'backspace' })
  })

  it('Given Backspace with empty field When mapped Then sends DEL', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'Backspace',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'send-bytes', bytes: '\x7f' })
  })

  it('Given Enter When mapped Then ignores so submit path owns CR', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'Enter',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'ignore' })
  })

  it('Given Option+ArrowLeft When mapped Then sends alt-modified CSI left', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'ArrowLeft',
          modifiers: { ctrl: false, alt: true, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: '' }
      )
    ).toEqual({ kind: 'send-bytes', bytes: '\x1b[1;3D' })
  })

  it('Given Tab with held Hangul When mapped Then flushes the field then sends tab', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'Tab',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '한', sentText: '' }
      )
    ).toEqual({ kind: 'flush-field-then-send', bytes: '\t' })
  })

  it('Given ArrowLeft after sent text When mapped Then resets the stale field baseline', () => {
    expect(
      mapTerminalLiveHardwareKeyEvent(
        {
          key: 'ArrowLeft',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          repeat: false
        },
        { heldText: '', sentText: 'ab' }
      )
    ).toEqual({ kind: 'flush-field-then-send', bytes: '\x1b[D' })
  })
})
