// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserHistoryGesture, type BrowserHistoryWheel } from '../shared/browser-history-gesture'
import { installBrowserHistoryWheel } from './browser-history-wheel'

describe('browser history wheel reporting', () => {
  let receive: (id: number | null) => void
  let cleanup: () => void
  let gesture: BrowserHistoryGesture
  let navigations: ('back' | 'forward')[]
  let reports: BrowserHistoryWheel[]

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="page"><div id="content"></div></div>'
    gesture = new BrowserHistoryGesture()
    navigations = []
    reports = []
    cleanup = installBrowserHistoryWheel(
      (callback) => {
        receive = callback
        return () => {}
      },
      (wheel) => {
        reports.push(wheel)
        const direction = gesture.record(wheel)
        if (direction) {
          navigations.push(direction)
        }
      }
    )
    receive(gesture.begin())
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  function wheel(init: WheelEventInit = {}, trusted = true): WheelEvent {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: -120,
      ...init
    })
    // Models a physical wheel event; a separate case verifies synthetic input is ignored.
    Object.defineProperty(event, 'isTrusted', { value: trusted })
    // happy-dom omits WheelEvent's inherited modifier initializers.
    for (const key of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      Object.defineProperty(event, key, { value: init[key] ?? false })
    }
    document.getElementById('content')!.dispatchEvent(event)
    return event
  }

  it('combines actual DOM wheel delivery with the native gesture gate', () => {
    wheel()
    wheel()
    vi.runAllTimers()
    expect(navigations).toEqual(['back'])
    receive(null)
    wheel()
    vi.runAllTimers()
    expect(navigations).toEqual(['back'])
  })

  it('preserves nested horizontal scrolling for the whole gesture', () => {
    const page = document.getElementById('page')!
    page.style.overflowX = 'auto'
    Object.defineProperties(page, { scrollWidth: { value: 1000 }, clientWidth: { value: 200 } })
    wheel()
    vi.runAllTimers()
    page.style.overflowX = 'visible'
    wheel()
    vi.runAllTimers()
    expect(reports[0]?.blocked).toBe(true)
    expect(navigations).toEqual([])
  })

  it('honors page cancellation even by a later window listener', () => {
    const cancel = (event: Event): void => event.preventDefault()
    window.addEventListener('wheel', cancel)
    try {
      wheel()
      vi.runAllTimers()
      expect(reports[0]?.blocked).toBe(true)
      expect(navigations).toEqual([])
    } finally {
      window.removeEventListener('wheel', cancel)
    }
  })

  it.each([{ ctrlKey: true }, { shiftKey: true }, { deltaMode: 1 }])(
    'preserves modified or non-pixel scrolling %j',
    (init) => {
      wheel(init)
      vi.runAllTimers()
      expect(navigations).toEqual([])
      expect(reports[0]?.blocked).toBe(true)
    }
  )

  it('ignores page-generated wheel events and cancelled gesture callbacks', () => {
    wheel({}, false)
    wheel()
    receive(null)
    gesture.end()
    vi.runAllTimers()
    expect(reports).toEqual([])
    expect(navigations).toEqual([])
  })

  it('removes its listener and pending reports when disposed', () => {
    wheel()
    cleanup()
    wheel()
    vi.runAllTimers()
    expect(reports).toEqual([])
  })
})
