import { describe, expect, it } from 'vitest'
import { MOUSE_DISABLE, MOUSE_ENABLE, parseMouseEvent, parseMouseEvents } from './mouse-input'
import { decodeKey } from './tty-key-adapter'

describe('parseMouseEvent', () => {
  it('parses a left-click press with 0-based coordinates', () => {
    expect(parseMouseEvent('\x1b[<0;10;5M')).toEqual({
      type: 'press',
      button: 'left',
      col: 9,
      row: 4
    })
  })

  it('parses right-click and a release', () => {
    expect(parseMouseEvent('\x1b[<2;3;3M')).toMatchObject({ type: 'press', button: 'right' })
    expect(parseMouseEvent('\x1b[<0;3;3m')).toMatchObject({ type: 'release' })
  })

  it('parses wheel up and down', () => {
    expect(parseMouseEvent('\x1b[<64;1;1M')).toMatchObject({ type: 'scroll', direction: 'up' })
    expect(parseMouseEvent('\x1b[<65;1;1M')).toMatchObject({ type: 'scroll', direction: 'down' })
  })

  it('returns null for non-mouse input', () => {
    expect(parseMouseEvent('q')).toBeNull()
    expect(parseMouseEvent('\x1b[A')).toBeNull()
  })

  it('does not collide with the key decoder (each ignores the other)', () => {
    const mouse = '\x1b[<0;10;5M'
    expect(parseMouseEvent(mouse)).not.toBeNull()
    expect(decodeKey(mouse)).toBeNull()
    const key = 'q'
    expect(decodeKey(key)).not.toBeNull()
    expect(parseMouseEvent(key)).toBeNull()
  })

  it('enable/disable sequences are inverse toggles', () => {
    expect(MOUSE_ENABLE).toContain('1006h')
    expect(MOUSE_DISABLE).toContain('1006l')
  })
})

describe('parseMouseEvents', () => {
  it('extracts every event from a batched chunk', () => {
    const events = parseMouseEvents('\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<65;1;1M')
    expect(events.map((event) => event.type)).toEqual(['press', 'release', 'scroll'])
  })

  it('finds the mouse event when mixed with other bytes', () => {
    const events = parseMouseEvents('q\x1b[<2;3;4M')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'press', button: 'right', col: 2, row: 3 })
  })

  it('returns nothing for input with no mouse reports', () => {
    expect(parseMouseEvents('hello\x1b[A')).toEqual([])
  })
})
