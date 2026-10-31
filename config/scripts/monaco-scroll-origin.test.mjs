// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { Scrollable } from 'monaco-editor/esm/vs/base/common/scrollable.js'
import {
  ScrollChangedEvent,
  ViewModelEventDispatcher
} from 'monaco-editor/esm/vs/editor/common/viewModelEventDispatcher.js'
import { StableEditorScrollState } from 'monaco-editor/esm/vs/editor/browser/stableEditorScroll.js'

afterEach(() => vi.useRealTimers())

it('retains producer provenance across smooth frames and keeps intervening queued user movement in order', () => {
  vi.useFakeTimers()
  const frames = []
  const native = new Scrollable({
    forceIntegerValues: true,
    smoothScrollDuration: 100,
    scheduleAtNextAnimationFrame: (callback) => {
      frames.push(callback)
      return { dispose() {} }
    }
  })
  const dispatcher = new ViewModelEventDispatcher()
  const events = []
  dispatcher.onEvent((event) => events.push(event))
  native.onScroll((event) =>
    dispatcher.emitOutgoingEvent(
      new ScrollChangedEvent(
        event.oldScrollWidth,
        event.oldScrollLeft,
        event.oldScrollHeight,
        event.oldScrollTop,
        event.scrollWidth,
        event.scrollLeft,
        event.scrollHeight,
        event.scrollTop,
        event.scrollSource
      )
    )
  )
  native.setScrollDimensions(
    { width: 800, height: 700, scrollWidth: 800, scrollHeight: 40000 },
    true,
    'geometry'
  )
  native.setScrollPositionNow({ scrollTop: 9610 })
  events.length = 0
  dispatcher.beginEmitViewEvents()
  native.setScrollPositionNow({ scrollTop: 0 }, 'geometry')
  native.setScrollPositionNow({ scrollTop: 20 })
  native.setScrollPositionNow({ scrollTop: 19 }, 'geometry')
  dispatcher.endEmitViewEvents()
  expect(events.map((event) => [event.scrollSource, event.scrollTopDelta])).toEqual([
    ['geometry', -9610],
    [undefined, 20],
    ['geometry', -1]
  ])
  events.length = 0
  native.setScrollPositionSmooth({ scrollTop: 1000 }, undefined, 'geometry')
  vi.advanceTimersByTime(25)
  frames.shift()()
  expect(events.length).toBeGreaterThan(0)
  expect(events.every((event) => event.scrollSource === 'geometry')).toBe(true)
  native.setScrollPositionNow({ scrollTop: 70 })
  expect(events.at(-1).scrollSource).toBeUndefined()
  dispatcher.dispose()
  native.dispose()
})

it('marks the installed stable-zone restoration as geometry when inline deleted space becomes split space', () => {
  const native = new Scrollable({
    forceIntegerValues: true,
    smoothScrollDuration: 0,
    scheduleAtNextAnimationFrame: () => ({ dispose() {} })
  })
  native.setScrollDimensions(
    { width: 800, height: 700, scrollWidth: 800, scrollHeight: 40000 },
    true
  )
  native.setScrollPositionNow({ scrollTop: 9610 })
  const events = []
  native.onScroll((event) => events.push(event))
  const pane = {
    getScrollTop: () => native.getCurrentScrollPosition().scrollTop,
    getContentHeight: () => 20000,
    getTopForPosition: () => 0,
    setScrollTop: (scrollTop, _type, source) => native.setScrollPositionNow({ scrollTop }, source)
  }
  const state = new StableEditorScrollState(9610, 40000, { lineNumber: 1, column: 1 }, -10390, null)
  state.restore(pane)
  expect(pane.getScrollTop()).toBe(0)
  expect(events).toHaveLength(1)
  expect(events[0].scrollSource).toBe('geometry')
  native.dispose()
})

it('acknowledges installed Find/Replace top-zone resizing and closing without treating them as navigation', async () => {
  const { FindWidget } =
    await import('monaco-editor/esm/vs/editor/contrib/find/browser/findWidget.js')
  const native = new Scrollable({
    forceIntegerValues: true,
    smoothScrollDuration: 0,
    scheduleAtNextAnimationFrame: () => ({ dispose() {} })
  })
  native.setScrollDimensions(
    { width: 800, height: 700, scrollWidth: 800, scrollHeight: 40000 },
    true
  )
  native.setScrollPositionNow({ scrollTop: 400 })
  const events = []
  native.onScroll((event) => events.push(event))
  const widget = {
    _isVisible: true,
    _viewZone: { heightInPx: 33 },
    _viewZoneId: 'find',
    _getHeight: () => 62,
    _codeEditor: {
      getOption: () => ({ addExtraSpaceOnTop: true }),
      getScrollTop: () => native.getCurrentScrollPosition().scrollTop,
      setScrollTop: (scrollTop, _type, cause) => native.setScrollPositionNow({ scrollTop }, cause),
      changeViewZones: (change) => change({ layoutZone() {}, removeZone() {} })
    }
  }
  FindWidget.prototype._showViewZone.call(widget)
  expect(native.getCurrentScrollPosition().scrollTop).toBe(429)
  FindWidget.prototype._removeViewZone.call(widget)
  expect(native.getCurrentScrollPosition().scrollTop).toBe(367)
  expect(events.map((event) => event.scrollSource)).toEqual(['geometry', 'geometry'])
  native.dispose()
})
