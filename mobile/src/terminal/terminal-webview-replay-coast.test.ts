// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocument } from './document/create-terminal-document'
import { terminalDocumentDouble } from './document/document-terminal-double.test-support'
import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'

describe('snapshot replacement ends the previous terminal scroll', () => {
  let now: number
  let nextFrame: number
  let frames: Map<number, FrameRequestCallback>
  let scrolls: number[]
  let inputs: string[]
  let alternate: boolean
  let messages: Array<{ type: string; enabled?: boolean }>
  let oldSurface: HTMLElement
  let stopDocument: (() => void) | undefined

  function frame() {
    now += 16
    const pending = [...frames]
    for (const [id, callback] of pending) {
      if (frames.delete(id)) {
        callback(now)
      }
    }
  }

  function settle() {
    for (let count = 0; count < 20 && frames.size; count++) {
      frame()
    }
  }

  function init(preserveScroll = false) {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'init',
          cols: 40,
          rows: 24,
          initialData: alternate ? '\x1b[?1049h\x1b[?1000h\x1b[?1006h' : '',
          preserveScroll
        })
      })
    )
  }

  function touchPoints(
    type: string,
    points: Array<{ x: number; y: number }>,
    surface = oldSurface
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: points.map((point, identifier) => ({
        identifier,
        clientX: point.x,
        clientY: point.y,
        target: surface
      }))
    })
    Object.defineProperty(event, 'timeStamp', { value: now })
    surface.dispatchEvent(event)
  }

  function touch(type: string, y: number, surface = oldSurface) {
    touchPoints(type, type === 'touchend' ? [] : [{ x: 40, y }], surface)
  }

  function boot(program: boolean, disposable = false) {
    alternate = program
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    if (disposable) {
      stopDocument = createTerminalDocument().stop
    } else {
      new Function(TERMINAL_DOCUMENT_SCRIPT)()
    }
    init()
    settle()
    oldSurface = document.getElementById('terminal-surface')!
    if (program) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'write', data: '\x1b[?1000h\x1b[?1006h' })
        })
      )
    }
    settle()
    scrolls.length = 0
    inputs.length = 0
  }

  function fling() {
    touch('touchstart', 400)
    for (let step = 1; step <= 4; step++) {
      now += 16
      touch('touchmove', 400 - step * 25)
      frame()
    }
    touch('touchend', 300)
    frame()
    expect(alternate ? inputs.length : scrolls.length).toBeGreaterThan(0)
    scrolls.length = 0
    inputs.length = 0
  }

  beforeEach(() => {
    now = 1000
    nextFrame = 1
    frames = new Map()
    scrolls = []
    inputs = []
    alternate = false
    messages = []
    stopDocument = undefined
    vi.spyOn(window, 'addEventListener')
    vi.spyOn(document, 'addEventListener')
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 381 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 612 })
    Object.assign(window, {
      ReactNativeWebView: {
        postMessage(raw: string) {
          const msg = JSON.parse(raw)
          messages.push(msg)
          if (msg.type === 'terminal-input') {
            inputs.push(msg.bytes)
          }
        }
      },
      Terminal: function () {
        const buffer = {
          baseY: 1000,
          viewportY: 500,
          type: alternate ? 'alternate' : 'normal',
          cursorY: 0,
          length: 1000,
          getLine: () => undefined
        }
        let element: HTMLElement | undefined
        return {
          ...terminalDocumentDouble().terminal,
          cols: 40,
          rows: 24,
          modes: { mouseTrackingMode: alternate ? 'vt200' : 'none' },
          _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } },
          buffer: { active: buffer },
          get element() {
            return element
          },
          open(surface: HTMLElement) {
            element = surface
          },
          scrollLines(rows: number) {
            buffer.viewportY += rows
            scrolls.push(rows)
          },
          setViewportPixelOffset() {
            return true
          }
        }
      }
    })
  })

  afterEach(() => {
    stopDocument?.()
    for (const [type, listener, options] of vi.mocked(window.addEventListener).mock.calls) {
      window.removeEventListener(type, listener, options)
    }
    for (const [type, listener, options] of vi.mocked(document.addEventListener).mock.calls) {
      document.removeEventListener(type, listener, options)
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    'does not coast into the replacement (program=%s, preserveScroll=%s)',
    (program, preserveScroll) => {
      boot(program)
      fling()
      init(preserveScroll)
      settle()
      expect(inputs).toEqual([])
      expect(scrolls).toEqual([])
    }
  )

  it('drops an unpainted normal-buffer drag when the snapshot is replaced', () => {
    boot(false)
    touch('touchstart', 400)
    now += 16
    touch('touchmove', 360)
    expect(scrolls).toEqual([])
    init(true)
    settle()
    expect(scrolls).toEqual([])
  })

  it('ignores movement from a finger on the retired surface', () => {
    boot(false)
    touch('touchstart', 400)
    init(true)
    settle()
    now += 16
    touch('touchmove', 360)
    settle()
    touch('touchend', 360)
    settle()
    expect(scrolls).toEqual([])
  })

  it('cancels a pending long press when its terminal is replaced', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boot(false)
    touch('touchstart', 400)
    init()
    settle()
    messages.length = 0
    vi.advanceTimersByTime(500)
    expect(
      messages.filter((message) => message.type === 'set-select-mode' && message.enabled)
    ).toEqual([])
  })

  it('does not launch an old finger’s velocity after snapshot replacement', () => {
    boot(false)
    touch('touchstart', 400)
    now += 16
    touch('touchmove', 360)
    frame()
    init(true)
    settle()
    scrolls.length = 0
    touch('touchend', 360)
    settle()
    expect(scrolls).toEqual([])
  })

  it('retires an unfinished pinch while allowing a new pinch after replay', () => {
    boot(false)
    touchPoints('touchstart', [
      { x: 40, y: 300 },
      { x: 80, y: 300 }
    ])
    touchPoints('touchmove', [
      { x: 30, y: 300 },
      { x: 90, y: 300 }
    ])
    init(true)
    settle()
    messages.length = 0
    touch('touchend', 300)
    expect(messages.filter((message) => message.type === 'font-scale-changed')).toEqual([])

    oldSurface = document.getElementById('terminal-surface')!
    touchPoints('touchstart', [
      { x: 40, y: 300 },
      { x: 80, y: 300 }
    ])
    touchPoints('touchmove', [
      { x: 20, y: 300 },
      { x: 100, y: 300 }
    ])
    touch('touchend', 300)
    expect(messages.filter((message) => message.type === 'font-scale-changed')).toHaveLength(1)
  })

  it('keeps long presses usable after repeated replacements', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boot(false)
    touch('touchstart', 400)
    init(true)
    init()
    settle()
    messages.length = 0
    vi.advanceTimersByTime(500)
    expect(
      messages.filter((message) => message.type === 'set-select-mode' && message.enabled)
    ).toEqual([])

    oldSurface = document.getElementById('terminal-surface')!
    touch('touchstart', 400)
    vi.advanceTimersByTime(500)
    expect(
      messages.filter((message) => message.type === 'set-select-mode' && message.enabled)
    ).toHaveLength(1)
  })

  it.each(['coast', 'queued drag'])(
    'stops %s on dispose without affecting a later mount',
    (motion) => {
      boot(false, true)
      if (motion === 'coast') {
        fling()
      } else {
        touch('touchstart', 400)
        now += 16
        touch('touchmove', 360)
      }
      const stopPrevious = stopDocument
      if (!stopPrevious) {
        throw new Error('Disposable document did not start')
      }
      stopPrevious()
      scrolls.length = 0
      inputs.length = 0
      touch('touchend', 360)
      settle()
      expect(scrolls).toEqual([])
      expect(inputs).toEqual([])

      boot(false, true)
      stopPrevious()
      fling()
      frame()
      expect(scrolls.length).toBeGreaterThan(0)
    }
  )

  it('drops a pending long press on dispose', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boot(false, true)
    touch('touchstart', 400)
    stopDocument?.()
    messages.length = 0
    vi.advanceTimersByTime(500)
    touch('touchend', 400)
    settle()
    expect(messages).toEqual([])
  })

  it.each([false, true])('still accepts a new fling after replacement (program=%s)', (program) => {
    boot(program)
    fling()
    init()
    settle()
    oldSurface = document.getElementById('terminal-surface')!
    if (program) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'write', data: '\x1b[?1000h\x1b[?1006h' })
        })
      )
    }
    settle()
    scrolls.length = 0
    inputs.length = 0
    fling()
    for (let count = 0; count < 4; count++) {
      frame()
    }
    expect(alternate ? inputs.length : scrolls.length).toBeGreaterThan(0)
  })
})
