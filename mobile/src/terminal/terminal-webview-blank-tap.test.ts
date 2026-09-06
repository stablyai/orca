// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { TERMINAL_TAP_DISPATCH_JS } from './terminal-webview-tap-dispatch-injected'

function boot(selecting = false) {
  const document = globalThis.document.implementation.createHTMLDocument()
  document.body.innerHTML =
    '<div id="terminal-container"><div id="surface"></div></div><div id="overlay"></div>'
  const container = document.getElementById('terminal-container')!
  const surface = document.getElementById('surface')!
  const posted = vi.fn()
  const cellTap = vi.fn()
  const select = vi.fn()
  const cancel = vi.fn()
  new Function(
    'document',
    'notify',
    'notifyTerminalSurfaceTap',
    'enterSelect',
    'onCancel',
    `
    var surface = document.getElementById('surface');
    var selectionOverlay = document.getElementById('overlay');
    var handleStart = {}, handleEnd = {}, sel = {}, selMode = ${JSON.stringify(selecting ? 'select' : 'idle')};
    var tapCandidate = null, longPressTimer = null, longPressOrigin = null;
    var LONG_PRESS_MS = 500, LONG_PRESS_SLOP = 10, TAP_SLOP = 24, TAP_MAX_MS = 700;
    function viewportToCell() { throw new Error('Blank space has no cell'); }
    function cancelSelect() { selMode = 'idle'; onCancel(); }
    function handleDragMove() {}
    function stopEdgeScroll() {}
    ${TERMINAL_TAP_DISPATCH_JS}
  `
  )(document, posted, cellTap, select, cancel)
  const touch = (type: string, points: number[][], target = container) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: target })
    Object.defineProperty(event, 'touches', {
      value: points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY }))
    })
    document.dispatchEvent(event)
  }
  return { touch, posted, cellTap, select, cancel, surface }
}

afterEach(() => vi.useRealTimers())

it('restores focus on blank container taps without resolving cells or links', () => {
  const h = boot()
  h.touch('touchstart', [[20, 300]])
  h.touch('touchend', [])
  expect(h.posted.mock.calls).toEqual([[{ type: 'terminal-tap' }]])
  expect(h.cellTap).not.toHaveBeenCalled()
  expect(h.select).not.toHaveBeenCalled()
})

it.each(['move', 'cancel', 'pinch', 'three-finger pinch', 'hold'])(
  'does not focus for a blank-space %s',
  (kind) => {
    vi.useFakeTimers()
    const h = boot()
    h.touch('touchstart', [[20, 300]])
    if (kind === 'move') {
      h.touch('touchmove', [[20, 340]])
    }
    if (kind === 'cancel') {
      h.touch('touchcancel', [])
    }
    if (kind === 'pinch' || kind === 'three-finger pinch') {
      h.touch('touchstart', [
        [20, 300],
        [40, 300]
      ])
    }
    if (kind === 'three-finger pinch') {
      h.touch('touchstart', [
        [20, 300],
        [40, 300],
        [60, 300]
      ])
    }
    if (kind === 'hold') {
      vi.advanceTimersByTime(550)
    }
    h.touch('touchend', [])
    expect(h.posted).not.toHaveBeenCalled()
    expect(h.cellTap).not.toHaveBeenCalled()
    expect(h.select).not.toHaveBeenCalled()
  }
)

it('dismisses selection first and only focuses on the next blank tap', () => {
  const h = boot(true)
  h.touch('touchstart', [[20, 300]])
  h.touch('touchend', [])
  expect(h.cancel).toHaveBeenCalledOnce()
  expect(h.posted).not.toHaveBeenCalled()
  h.touch('touchstart', [[20, 300]])
  h.touch('touchend', [])
  expect(h.posted).toHaveBeenCalledWith({ type: 'terminal-tap' })
})
