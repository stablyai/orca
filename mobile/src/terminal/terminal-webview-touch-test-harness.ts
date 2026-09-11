import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { vi } from 'vitest'
import { TERMINAL_TAP_DISPATCH_JS } from './terminal-webview-tap-dispatch-injected'
import { TERMINAL_HTML_SELECTION_STATE_AND_EVICTION } from './terminal-webview-html/selection-state-and-eviction'

type TouchEvent = {
  target: object
  touches: Array<{ identifier: number; clientX: number; clientY: number }>
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
}
type TouchListener = {
  handler: (event: TouchEvent) => void
  capture: boolean
  passive: boolean
}

function createTouchTarget() {
  const listeners = new Map<string, TouchListener>()
  return {
    listeners,
    addEventListener(
      type: string,
      handler: TouchListener['handler'],
      options: boolean | AddEventListenerOptions = false
    ) {
      listeners.set(type, {
        handler,
        capture: typeof options === 'boolean' ? options : (options.capture ?? false),
        passive: typeof options === 'boolean' ? false : (options.passive ?? false)
      })
    }
  }
}

export function createTerminalTouchHarness(ios = true) {
  const source = readFileSync(
    new URL('./terminal-webview-html/surface-touch-gestures.ts', import.meta.url),
    'utf8'
  )
  const cell = {}
  const handleStart = {}
  const handleEnd = {}
  const context = {
    document: {
      ...createTouchTarget(),
      getElementById(id: string) {
        if (id === 'sel-handle-start') {
          return handleStart
        }
        if (id === 'sel-handle-end') {
          return handleEnd
        }
        return { contains: (target: object) => target === handleStart || target === handleEnd }
      }
    },
    surface: { ...createTouchTarget(), contains: (target: object) => target === cell },
    attachSurfaceWheelHandler: vi.fn(),
    attachSurfaceMouseClickDragHandler: vi.fn(),
    isIOSWebView: () => ios,
    term: { element: { scrollWidth: 800 } },
    window: { innerWidth: 400 },
    getTotalScale: () => 1,
    getCellHeight: () => 15,
    shouldRouteScrollToTerminalInput: () => false,
    enqueueNormalBufferScrollDelta: vi.fn(() => true),
    applyNormalBufferScrollDelta: vi.fn(() => true),
    resetSmoothScrollOffset: vi.fn(),
    routeScrollLines: vi.fn(),
    clampPan: vi.fn(),
    updateTransform: vi.fn(),
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
    viewportToCell: () => ({ col: 0, row: 0 }),
    enterSelect: vi.fn(),
    cancelSelect: vi.fn(),
    handleDragMove: vi.fn(),
    stopEdgeScroll: vi.fn(),
    notify: vi.fn(),
    notifyTerminalSurfaceTap: vi.fn(),
    tapCandidate: null as object | null,
    longPressTimer: null as ReturnType<typeof setTimeout> | null,
    longPressOrigin: null as object | null,
    selMode: 'navigate',
    sel: null as { activeHandle: string | null } | null,
    panX: 0,
    panY: 0,
    userScale: 1,
    currentTextScale: 1,
    MIN_TEXT_SCALE: 0.5,
    MAX_TEXT_SCALE: 2,
    setTimeout,
    clearTimeout,
    Date,
    Math
  }
  context.enterSelect.mockImplementation(() => {
    context.selMode = 'select'
    context.sel = { activeHandle: null }
  })
  context.cancelSelect.mockImplementation(() => {
    context.selMode = 'navigate'
    context.sel = null
  })
  const start = source.indexOf('  var ts =')
  if (start === -1) {
    throw new Error('Terminal touch handlers not found')
  }
  new Script(
    TERMINAL_HTML_SELECTION_STATE_AND_EVICTION +
      TERMINAL_TAP_DISPATCH_JS +
      source.slice(start, source.lastIndexOf('`'))
  ).runInNewContext(context)
  const descendantTouchMove = vi.fn((event: TouchEvent) => event.preventDefault())
  const descendantTouchEnd = vi.fn()

  function touch(type: string, points: Array<[number, number]>, target = cell) {
    let stopped = false
    let passive = false
    let defaultPrevented = false
    const event: TouchEvent = {
      target,
      touches: points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY })),
      preventDefault: vi.fn(() => {
        if (!passive) {
          defaultPrevented = true
        }
      }),
      stopPropagation: vi.fn(() => {
        stopped = true
      })
    }
    const ancestors = target === cell ? [context.document, context.surface] : [context.document]
    function dispatchListener(listener: TouchListener | undefined, capture: boolean) {
      if (stopped || !listener || listener.capture !== capture) {
        return
      }
      passive = listener.passive
      listener.handler(event)
    }
    for (const ancestor of ancestors) {
      dispatchListener(ancestor.listeners.get(type), true)
    }
    if (!stopped && target === cell) {
      passive = false
      if (type === 'touchmove') {
        descendantTouchMove(event)
      } else if (type === 'touchend') {
        descendantTouchEnd(event)
      }
    }
    for (const ancestor of ancestors.toReversed()) {
      dispatchListener(ancestor.listeners.get(type), false)
    }
    return { ...event, defaultPrevented }
  }

  return { touch, context, descendantTouchMove, descendantTouchEnd, handleStart }
}
