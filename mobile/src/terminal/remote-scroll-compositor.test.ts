import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginRemoteScrollPresentation,
  cancelRemoteScrollPresentation,
  consumeRemoteScrollTouchCatch,
  disposeRemoteScrollPresentation
} from './remote-scroll-compositor.mjs'

class Surface {
  width = 0
  height = 0
  offsetWidth = 400
  style: Record<string, string> = {}
  children: Surface[] = []
  context = { drawImage: vi.fn(), clearRect: vi.fn() }
  appendChild(child: Surface) {
    this.children.push(child)
  }
  replaceChildren(child: Surface) {
    this.children = [child]
  }
  remove() {
    this.children = []
  }
  getContext() {
    return this.context
  }
  setAttribute() {}
}

function fixture() {
  vi.useFakeTimers()
  const created: Surface[] = [],
    listeners = new Set<() => void>()
  let first = 100,
    selected = false,
    reduced = false
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    defaultView: { matchMedia: () => ({ matches: reduced }) },
    createElement: () => {
      const surface = new Surface()
      created.push(surface)
      return surface
    }
  })
  const source = new Surface()
  source.width = 1200
  source.height = 714
  source.style.width = '400px'
  const terminal = {
    rows: 14,
    cols: 2,
    modes: { mouseTrackingMode: 'none' },
    element: { ownerDocument: document },
    hasSelection: () => selected,
    buffer: {
      active: {
        type: 'alternate',
        viewportY: 0,
        getLine: (row: number) => ({
          translateToString: () =>
            row === 0
              ? 'Title: new status'
              : row === 13
                ? 'Input: waiting'
                : `work item ${first + row}`,
          getCell: () => ({ fg: 1, bg: 0 })
        })
      }
    },
    _core: {
      screenElement: new Surface(),
      _renderService: {
        _renderer: {
          value: {
            _gl: {} as object | null,
            _canvas: source,
            dimensions: { css: { cell: { height: 17 } } },
            renderRows: vi.fn()
          }
        }
      }
    },
    onRender(callback: () => void) {
      listeners.add(callback)
      return { dispose: () => listeners.delete(callback) }
    }
  }
  const render = () => {
    for (const callback of listeners) {
      callback()
    }
  }
  const move = (amount: number) => {
    first += amount
    render()
  }
  vi.stubGlobal('getComputedStyle', (surface: Surface) => ({
    transform: surface.style.transform ?? 'none'
  }))
  const shown = () => created.some((surface) => surface.style.display === 'block')
  return {
    terminal,
    document,
    created,
    listeners,
    move,
    shown,
    select: () => {
      selected = true
    },
    reduce: () => {
      reduced = true
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('remote scroll presentation lifetime', () => {
  it('leaves the normal buffer renderer and listener lifetime untouched', () => {
    const f = fixture()
    f.terminal.buffer.active.type = 'normal'
    beginRemoteScrollPresentation(f.terminal, -1)
    expect(f.terminal._core._renderService._renderer.value.renderRows).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
    expect(f.created).toHaveLength(0)
  })
  it('presents mouse-aware normal-buffer TUIs while leaving a DOM fallback untouched', () => {
    const f = fixture()
    f.terminal.buffer.active.type = 'normal'
    f.terminal.modes.mouseTrackingMode = 'vt200'
    beginRemoteScrollPresentation(f.terminal, -1)
    f.move(-1)
    expect(f.shown()).toBe(true)
    disposeRemoteScrollPresentation(f.terminal)
    f.terminal._core._renderService._renderer.value._gl = null
    beginRemoteScrollPresentation(f.terminal, -1)
    expect(f.listeners.size).toBe(0)
  })
  it('captures before sending, animates the confirmed body, and releases idle textures', () => {
    const f = fixture()
    beginRemoteScrollPresentation(f.terminal, -1)
    expect(f.terminal._core._renderService._renderer.value.renderRows).toHaveBeenCalled()
    f.move(-1)
    expect(f.shown()).toBe(true)
    vi.advanceTimersByTime(55)
    expect(f.shown()).toBe(false)
    vi.advanceTimersByTime(350)
    expect(f.created.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true)
    disposeRemoteScrollPresentation(f.terminal)
    expect(f.listeners.size).toBe(0)
  })

  it.each(['touchstart', 'touchcancel', 'keydown', 'visibilitychange'])(
    'settles on %s',
    (event) => {
      const f = fixture()
      beginRemoteScrollPresentation(f.terminal, -1)
      f.move(-1)
      expect(f.shown()).toBe(true)
      f.document.dispatchEvent(new Event(event))
      expect(f.shown()).toBe(false)
      expect(consumeRemoteScrollTouchCatch(f.terminal)).toBe(event === 'touchstart')
      expect(consumeRemoteScrollTouchCatch(f.terminal)).toBe(false)
      expect(f.created.every((surface) => surface.width === 0)).toBe(true)
      disposeRemoteScrollPresentation(f.terminal)
    }
  )

  it('preserves selected content and reduced motion without an overlay', () => {
    const f = fixture()
    beginRemoteScrollPresentation(f.terminal, -1)
    f.select()
    f.move(-1)
    expect(f.shown()).toBe(false)
    cancelRemoteScrollPresentation(f.terminal)
    f.reduce()
    beginRemoteScrollPresentation(f.terminal, -1)
    expect(f.shown()).toBe(false)
    disposeRemoteScrollPresentation(f.terminal)
  })

  it('does not animate output in the opposite direction or fail terminal input on an unavailable renderer', () => {
    const f = fixture()
    beginRemoteScrollPresentation(f.terminal, -1)
    f.move(1)
    expect(f.shown()).toBe(false)
    disposeRemoteScrollPresentation(f.terminal)
    expect(() => beginRemoteScrollPresentation({}, -1)).not.toThrow()
  })
})
