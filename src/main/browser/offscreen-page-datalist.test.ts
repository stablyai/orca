import { describe, expect, it, vi } from 'vitest'
import type { OffscreenPageUserInput } from '../../shared/offscreen-page-protocol'
import { createOffscreenPageDatalistMirror } from './offscreen-page-datalist'

const VIEW = { width: 800, height: 600 }
// Electron invalidates the whole view in DIPs, popup rects in pixels.
const FULL = { x: 0, y: 0, width: 800, height: 600 }
// Four rows at 2x: 2 * (1 + 4 * 24 + 1) pixels tall.
const POPUP = { x: 80, y: 162, width: 416, height: 196 }

function key(name: string, type: 'keyDown' | 'keyUp' = 'keyDown'): OffscreenPageUserInput {
  return {
    kind: 'key',
    type,
    key: name,
    code: name,
    keyCode: 0,
    location: 0,
    repeat: false,
    text: '',
    modifiers: []
  }
}

function mouse(y: number): OffscreenPageUserInput {
  return {
    kind: 'mouse',
    type: 'mouseMove',
    x: 60,
    y,
    button: 'left',
    clickCount: 0,
    modifiers: [],
    heldButtons: []
  }
}

function setup() {
  const onChange = vi.fn()
  const queryItems = vi.fn()
  const mirror = createOffscreenPageDatalistMirror({ scaleFactor: 2, queryItems, onChange })
  const selected = () => onChange.mock.lastCall?.[0]?.selected
  return { mirror, onChange, queryItems, selected }
}

describe('createOffscreenPageDatalistMirror', () => {
  it('opens on a popup-rect paint in DIPs, asks for rows, and closes on an empty full paint', () => {
    const { mirror, onChange, queryItems } = setup()
    mirror.onBitmapPaint(POPUP, false, VIEW)
    expect(queryItems).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenLastCalledWith({
      rect: { x: 40, y: 81, width: 208, height: 98 },
      items: [],
      selected: null
    })
    mirror.setItems([{ value: 'apple', label: '' }])
    expect(onChange.mock.lastCall?.[0]?.items).toEqual([{ value: 'apple', label: '' }])
    mirror.onBitmapPaint(FULL, true, VIEW)
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('moves the selection like AutofillPopupView and wraps at both ends', () => {
    const { mirror, selected } = setup()
    mirror.onBitmapPaint(POPUP, false, VIEW)
    expect(mirror.onUserInput(key('ArrowUp'))).toBe(true)
    expect(selected()).toBe(3)
    mirror.onUserInput(key('ArrowDown'))
    expect(selected()).toBe(0)
    mirror.onUserInput(key('PageDown'))
    expect(selected()).toBe(3)
    expect(mirror.onUserInput(key('ArrowDown', 'keyUp'))).toBe(true)
    expect(selected()).toBe(3)
  })

  it('takes the pointer over the popup and keeps its row once the pointer leaves', () => {
    const { mirror, selected } = setup()
    mirror.onBitmapPaint(POPUP, false, VIEW)
    expect(mirror.onUserInput(mouse(81 + 1 + 24 + 5))).toBe(true)
    expect(selected()).toBe(1)
    expect(mirror.onUserInput(mouse(10))).toBe(false)
    expect(selected()).toBe(1)
  })

  it('takes Enter and Tab only with a selected row, and forgets it when typing rebuilds the popup', () => {
    const { mirror, selected, queryItems } = setup()
    mirror.onBitmapPaint(POPUP, false, VIEW)
    expect(mirror.onUserInput(key('Enter'))).toBe(false)
    mirror.onUserInput(key('ArrowDown'))
    expect(mirror.onUserInput(key('Tab'))).toBe(true)
    mirror.onBitmapPaint(FULL, false, VIEW)
    mirror.onBitmapPaint(POPUP, false, VIEW)
    expect(selected()).toBeNull()
    expect(queryItems).toHaveBeenCalledTimes(2)
  })

  it('leaves input alone while no popup is open', () => {
    const { mirror } = setup()
    expect(mirror.onUserInput(key('ArrowDown'))).toBe(false)
    expect(mirror.onUserInput(key('Escape'))).toBe(false)
  })
})
