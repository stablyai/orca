import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readTerminalWebViewHtmlSource } from './terminal-webview-html-source.test-support'
import { createTerminalTouchHarness } from './terminal-webview-touch-test-harness'

// The in-WebView JS lives in terminal-webview-html.ts; the RN wrapper in
// TerminalWebView.tsx. Concatenate both so assertions resolve regardless of file.
const source =
  readFileSync(new URL('./TerminalWebView.tsx', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-pending-messages.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-url-tap.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-tap-dispatch-injected.ts', import.meta.url), 'utf8') +
  readTerminalWebViewHtmlSource()
const sessionSource = readFileSync(
  new URL('../session/use-mobile-session-terminal-input.ts', import.meta.url),
  'utf8'
)
const sessionHelperSource = readFileSync(
  new URL('../session/mobile-session-route-helpers.ts', import.meta.url),
  'utf8'
)

function sliceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('TerminalWebView scroll routing', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('yields an iOS left-edge back swipe without panning, scrolling, tapping, or momentum', () => {
    const { touch, context, descendantTouchMove, descendantTouchEnd } = createTerminalTouchHarness()
    context.shouldRouteScrollToTerminalInput = () => true
    touch('touchstart', [[4, 200]])
    const move = touch('touchmove', [[84, 204]])
    expect(move.defaultPrevented).toBe(false)
    expect(move.preventDefault).not.toHaveBeenCalled()
    expect(move.stopPropagation).toHaveBeenCalled()
    expect(descendantTouchMove).not.toHaveBeenCalled()
    expect(context.tapCandidate).toBeNull()
    expect(context.longPressTimer).toBeNull()
    expect(touch('touchmove', [[2, 200]]).preventDefault).not.toHaveBeenCalled()
    const end = touch('touchend', [])
    expect(end.defaultPrevented).toBe(false)
    expect(end.preventDefault).not.toHaveBeenCalled()
    expect(descendantTouchEnd).not.toHaveBeenCalled()
    expect(end.stopPropagation).toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(context.notifyTerminalSurfaceTap).not.toHaveBeenCalled()
    expect(context.enterSelect).not.toHaveBeenCalled()
    expect(context.enqueueNormalBufferScrollDelta).not.toHaveBeenCalled()
    expect(context.routeScrollLines).not.toHaveBeenCalled()
    expect(context.updateTransform).not.toHaveBeenCalled()
    expect(context.requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('waits through initial finger jitter before handing a back swipe to iOS', () => {
    const { touch } = createTerminalTouchHarness()
    touch('touchstart', [[4, 200]])
    expect(touch('touchmove', [[3, 203]]).preventDefault).not.toHaveBeenCalled()
    expect(touch('touchmove', [[84, 200]]).preventDefault).not.toHaveBeenCalled()
  })

  it.each([
    ['Android edge swipe', false, 4, 84, 204],
    ['iOS interior swipe', true, 25, 105, 204],
    ['iOS edge scroll', true, 4, 6, 280],
    ['iOS leftward pan', true, 20, 2, 204]
  ] as const)('preserves terminal handling for %s', (_name, ios, startX, endX, endY) => {
    const { touch, context, descendantTouchEnd } = createTerminalTouchHarness(ios)
    touch('touchstart', [[startX, 200]])
    expect(touch('touchmove', [[endX, endY]]).preventDefault).toHaveBeenCalled()
    expect(context.enqueueNormalBufferScrollDelta).toHaveBeenCalled()
    touch('touchend', [])
    expect(descendantTouchEnd).toHaveBeenCalledOnce()
  })

  it('keeps an edge-origin vertical scroll in the terminal after a horizontal turn', () => {
    const { touch } = createTerminalTouchHarness()
    touch('touchstart', [[4, 200]])
    touch('touchmove', [[4, 230]])
    expect(touch('touchmove', [[84, 230]]).preventDefault).toHaveBeenCalled()
  })

  it('dispatches edge taps and clears their pending long press', () => {
    const { touch, context } = createTerminalTouchHarness()
    touch('touchstart', [[4, 200]])
    touch('touchmove', [[6, 202]])
    touch('touchend', [])
    expect(context.notifyTerminalSurfaceTap).toHaveBeenCalledExactlyOnceWith(4, 200, true)
    expect(context.tapCandidate).toBeNull()
    expect(context.longPressTimer).toBeNull()
    vi.advanceTimersByTime(600)
    expect(context.enterSelect).not.toHaveBeenCalled()
  })

  it('enters selection after a long press at the edge without dispatching a tap', () => {
    const { touch, context } = createTerminalTouchHarness()
    touch('touchstart', [[4, 200]])
    touch('touchmove', [[6, 202]])
    vi.advanceTimersByTime(500)
    expect(context.enterSelect).toHaveBeenCalledExactlyOnceWith(0, 0)
    touch('touchend', [])
    expect(context.notifyTerminalSurfaceTap).not.toHaveBeenCalled()
    expect(context.longPressOrigin).toBeNull()
  })

  it('clears the tap and long press as soon as a back swipe crosses its threshold', () => {
    const { touch, context } = createTerminalTouchHarness()
    touch('touchstart', [[4, 200]])
    touch('touchmove', [[12, 200]])
    vi.advanceTimersByTime(500)
    touch('touchend', [])
    expect(context.enterSelect).not.toHaveBeenCalled()
    expect(context.notifyTerminalSurfaceTap).not.toHaveBeenCalled()
  })

  it('leaves selection-handle drags to the document dispatcher', () => {
    const { touch, context, handleStart } = createTerminalTouchHarness()
    touch('touchstart', [[4, 200]])
    vi.advanceTimersByTime(500)
    touch('touchend', [])
    touch('touchstart', [[4, 200]], handleStart)
    expect(touch('touchmove', [[84, 200]], handleStart).defaultPrevented).toBe(true)
    expect(context.handleDragMove).toHaveBeenCalledWith('start', 84, 200)
    touch('touchcancel', [], handleStart)
    expect(context.sel?.activeHandle).toBeNull()
  })

  it('preserves pinch zoom when a second finger joins an edge touch', () => {
    const { touch, context } = createTerminalTouchHarness()
    touch('touchstart', [[4, 200]])
    touch('touchstart', [[4, 200], [100, 200]])
    expect(touch('touchmove', [[4, 200], [150, 200]]).preventDefault).toHaveBeenCalled()
    expect(context.updateTransform).toHaveBeenCalled()
  })

  it.each([false, true])('cleans up a cancelled edge touch (back swipe active: %s)', (active) => {
    const { touch, context } = createTerminalTouchHarness()
    touch('touchstart', [[4, 200]])
    if (active) {
      touch('touchmove', [[84, 200]])
    }
    touch('touchcancel', [])
    expect(context.tapCandidate).toBeNull()
    expect(context.longPressTimer).toBeNull()
    expect(context.longPressOrigin).toBeNull()
    expect(context.stopEdgeScroll).toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(context.enterSelect).not.toHaveBeenCalled()
    expect(context.notifyTerminalSurfaceTap).not.toHaveBeenCalled()
    touch('touchstart', [[100, 200]])
    expect(touch('touchmove', [[100, 250]]).preventDefault).toHaveBeenCalled()
  })

  it('keeps Android touch drags inside the terminal WebView', () => {
    expect(source).toContain('nestedScrollEnabled')
  })

  it('maps a downward pull at the bottom to older scrollback rows', () => {
    expect(source).toContain('var deltaY = ts.lastY - y;')
    expect(source).toContain('smoothScrollOffsetY -= deltaY;')
    expect(source).toContain('var lines = Math.trunc(-smoothScrollOffsetY / effectiveCellH);')

    const nextViewportY = simulateNormalBufferPull({
      baseY: 120,
      viewportY: 120,
      startY: 300,
      endY: 340,
      cellHeight: 20
    })

    expect(nextViewportY).toBe(118)
  })

  it('routes alternate-screen and mouse-aware scroll before smooth normal scroll', () => {
    expect(source).toContain(
      'return isWheelMouseTrackingMode(getMouseTrackingMode()) || isAlternateBufferActive();'
    )

    const touchMoveBlock = sliceBetween(
      "targetSurface.addEventListener('touchmove'",
      '}, { capture: true, passive: false });'
    )
    expect(touchMoveBlock.indexOf('if (shouldRouteScrollToTerminalInput())')).toBeLessThan(
      touchMoveBlock.indexOf('if (enqueueNormalBufferScrollDelta(deltaY))')
    )
    expect(touchMoveBlock).toContain('routeScrollLines(lines, x, y);')

    const momentumBlock = sliceBetween('function momentumStep()', 'if (Math.abs(vel) > MIN_VEL)')
    expect(momentumBlock.indexOf('if (shouldRouteScrollToTerminalInput())')).toBeLessThan(
      momentumBlock.indexOf('if (!applyNormalBufferScrollDelta(delta))')
    )
    expect(momentumBlock).toContain('routeScrollLines(lines, ts.lastX, ts.lastY);')
  })

  it('does not rubber-band normal scroll at scrollback edges', () => {
    expect(source).toContain('function canScrollNormalBufferDelta(deltaY)')
    const smoothScrollBlock = sliceBetween(
      'function applyNormalBufferScrollDelta(deltaY)',
      'function enqueueNormalBufferScrollDelta(deltaY)'
    )
    expect(smoothScrollBlock).toContain('if (!canScrollNormalBufferDelta(deltaY))')
    expect(smoothScrollBlock).toContain('resetSmoothScrollOffset();')
    expect(smoothScrollBlock).toContain('return false;')
    expect(smoothScrollBlock).toContain('return true;')

    const touchMoveBlock = sliceBetween(
      "targetSurface.addEventListener('touchmove'",
      '}, { capture: true, passive: false });'
    )
    expect(touchMoveBlock).toContain('if (enqueueNormalBufferScrollDelta(deltaY))')
    expect(touchMoveBlock).toContain('ts.velY = 0;')

    const momentumBlock = sliceBetween('function momentumStep()', 'if (Math.abs(vel) > MIN_VEL)')
    expect(momentumBlock).toContain('if (!applyNormalBufferScrollDelta(delta))')
    expect(momentumBlock).toContain('ts.momentumId = null;')
  })

  it('coalesces normal touch scroll row commits onto animation frames', () => {
    const enqueueBlock = sliceBetween(
      'function enqueueNormalBufferScrollDelta(deltaY)',
      'function resetSmoothScrollOffset()'
    )
    expect(enqueueBlock).toContain('pendingNormalScrollDeltaY += deltaY;')
    expect(enqueueBlock).toContain('if (normalScrollFrameId !== null) return true;')
    expect(enqueueBlock).toContain('normalScrollFrameId = requestAnimationFrame(function()')
    expect(enqueueBlock).toContain('applyNormalBufferScrollDelta(delta)')

    const resetBlock = sliceBetween(
      'function resetSmoothScrollOffset()',
      'function cellToViewportPx'
    )
    expect(resetBlock).toContain('pendingNormalScrollDeltaY = 0;')
    expect(resetBlock).toContain('cancelAnimationFrame(normalScrollFrameId);')
  })

  it('drains terminal writes without shifting the queued array', () => {
    expect(source).toContain('var writeQueueHead = 0;')
    expect(source).toContain('function nextQueuedWrite()')
    expect(source).toContain('writeQueueHead++;')
    expect(source).toContain('writeQueue = writeQueue.slice(writeQueueHead);')
    expect(source).not.toContain('writeQueue.shift()')
  })

  it('bounds native-side pending WebView writes while preserving control messages', () => {
    expect(source).toContain('const MAX_PENDING_WEB_WRITE_BYTES = 1_000_000')
    expect(source).toContain('const MAX_PENDING_WEB_WRITE_MESSAGES = 4096')
    expect(source).toContain('let pendingWriteBytes = 0')
    expect(source).toContain('let pendingWriteCount = 0')
    expect(source).toContain('const queue = (msg: TerminalWebViewCommand)')
    expect(source).toContain('pendingWriteCount > MAX_PENDING_WEB_WRITE_MESSAGES')
    expect(source).toContain("candidate.type === 'write'")
    expect(source).toContain('pendingMessages.queue(msg)')
    expect(source).toContain('pendingMessages.clear()')
  })

  it('clears WebView await timers when the real response wins', () => {
    const measureBlock = sliceBetween('measureFitDimensions(', 'resetZoom()')
    expect(measureBlock).toContain('clearTimeout(timeout)')
    expect(measureBlock).toContain('measureResolveRef.current === finish')

    const readyBlock = sliceBetween('async awaitReady()', '})')
    expect(readyBlock).toContain('clearTimeout(timeout)')
    expect(readyBlock).toContain('void p.finally')
  })

  it('hides xterm scrollbars and drives the mobile scroll indicator from committed rows', () => {
    expect(source).toContain('<div id="scroll-indicator"><div id="scroll-thumb"></div></div>')
    expect(source).toContain('.xterm .xterm-viewport::-webkit-scrollbar')
    expect(source).toContain('.xterm .xterm-scrollable-element > .xterm-scrollbar')
    expect(source).toContain('overflow-y: hidden !important;')
    expect(source).toContain('display: none !important;')
    expect(source).toContain('function updateScrollIndicator(reveal)')
    expect(source).toContain('buffer.viewportY / maxViewportY')
    expect(source).not.toContain('fractionalRows')
    expect(source).toContain('scrollThumb.style.transform =')
    expect(source).toContain('updateScrollIndicator(true);')
  })

  it('does not apply fractional smooth scroll transforms to terminal content', () => {
    const updateTransformBlock = sliceBetween(
      'function updateTransform()',
      'function updateScrollIndicator(reveal)'
    )
    expect(updateTransformBlock).toContain(
      "surface.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + getTotalScale() + ')';"
    )
    expect(source).not.toContain("querySelector('.xterm-screen')")
    expect(source).not.toContain('updateTerminalScreenTransform')
    expect(updateTransformBlock).not.toContain("getVisualPanY() + 'px) scale('")
    expect(updateTransformBlock).not.toContain('smoothScrollOffsetY')
  })

  it('smooths velocity samples and uses lower friction for mobile momentum', () => {
    expect(source).toContain('function updateTouchVelocity(deltaY, dt)')
    expect(source).toContain('ts.velY * 0.55 + instantVelocity * 0.45')
    expect(source).toContain('var FRICTION = 0.972;')
    expect(source).toContain('var MIN_VEL = 0.012;')
  })

  it('keeps selection edge autoscroll active and extends the dragged endpoint', () => {
    const startBlock = sliceBetween('function startEdgeScroll(dir)', 'function stopEdgeScroll()')
    expect(startBlock.indexOf('stopEdgeScroll();')).toBeLessThan(
      startBlock.indexOf('edgeScrollDir = dir;')
    )
    expect(startBlock.indexOf('term.scrollLines(edgeScrollDir);')).toBeLessThan(
      startBlock.indexOf('syncEdgeScrollSelectionEndpoint();')
    )

    const dragMoveBlock = sliceBetween(
      'function handleDragMove(handle, clientX, clientY)',
      '  // Latching document-level touch dispatcher: see'
    )
    expect(dragMoveBlock).toContain('edgeScrollClientX = clientX;')
    expect(dragMoveBlock).toContain('edgeScrollClientY = clientY;')
    expect(dragMoveBlock).toContain('syncSelectionHandleToViewportPoint(handle, clientX, clientY)')
  })

  it('opens links and paths from surface taps before mouse/focus fallback', () => {
    expect(source).toContain('function buildMouseClickInput(clientX, clientY)')
    expect(source).toContain('function isClickMouseTrackingMode(mode)')
    expect(source).toContain("return mode !== 'none';")
    expect(source).toContain('var pixelX = cell.x;')
    expect(source).toContain('var pixelY = cell.y;')
    expect(source).toContain(
      'if (!isSafeSgrMouseCoordinate(cell.x) || !isSafeSgrMouseCoordinate(cell.y)) return'
    )
    expect(source).toContain(
      'if (!isSafeSgrMouseCoordinate(sgrCol) || !isSafeSgrMouseCoordinate(sgrRow)) return'
    )
    expect(source).toContain("if (mouseTrackingMode === 'x10') return pixelPress;")
    expect(source).toContain("if (mouseTrackingMode === 'x10') return sgrPress;")
    expect(source).toContain("if (mouseTrackingMode === 'x10') return press;")
    expect(source).toContain("if (col > 126 || row > 126) return '';")

    const touchEndBlock = sliceBetween(
      "document.addEventListener('touchend'",
      '}, { capture: true, passive: true });'
    )
    expect(touchEndBlock).toContain(
      'notifyTerminalSurfaceTap(tapCandidate.x, tapCandidate.y, true)'
    )

    const tapHandlerBlock = sliceBetween(
      'function notifyTerminalSurfaceTap(originX, originY, focusKeyboard)',
      "document.addEventListener('touchstart'"
    )
    expect(tapHandlerBlock.indexOf('oscLinkAtViewportPoint')).toBeLessThan(
      tapHandlerBlock.indexOf('urlAtViewportPoint')
    )
    expect(tapHandlerBlock.indexOf('urlAtViewportPoint')).toBeLessThan(
      tapHandlerBlock.indexOf('filePathAtViewportPoint')
    )
    expect(tapHandlerBlock.indexOf('filePathAtViewportPoint')).toBeLessThan(
      tapHandlerBlock.indexOf('var clickInput = buildMouseClickInput')
    )
    expect(tapHandlerBlock).toContain("notify({ type: 'open-url', url: tappedUrl });")
    expect(tapHandlerBlock).toContain("notify({ type: 'terminal-input', bytes: clickInput });")
    expect(tapHandlerBlock).toContain(
      'if (focusKeyboard || !isClickMouseTrackingMode(getMouseTrackingMode()))'
    )
    expect(tapHandlerBlock).toContain("notify({ type: 'terminal-tap' });")
  })

  it('allows x10 mouse gesture reports through the mobile session gate', () => {
    expect(sessionHelperSource).toContain('function isGestureMouseTrackingMode')
    expect(sessionHelperSource).toContain(
      "return mode === 'x10' || mode === 'vt200' || mode === 'drag' || mode === 'any'"
    )

    const inputBlockStart = sessionSource.indexOf('const handleTerminalInput = useCallback')
    expect(inputBlockStart).toBeGreaterThanOrEqual(0)
    const inputBlockEnd = sessionSource.indexOf(
      'async function handleClearTerminal',
      inputBlockStart
    )
    expect(inputBlockEnd).toBeGreaterThan(inputBlockStart)
    const inputBlock = sessionSource.slice(inputBlockStart, inputBlockEnd)
    expect(inputBlock).toContain('!isGestureMouseTrackingMode(modes?.mouseTrackingMode)')
    expect(inputBlock).toContain('const sequenceCount = countTerminalGestureInputSequences(bytes)')
    expect(inputBlock.indexOf('countTerminalGestureInputSequences')).toBeLessThan(
      inputBlock.indexOf('enqueueTerminalGestureInput')
    )
  })
})

function simulateNormalBufferPull({
  baseY,
  viewportY,
  startY,
  endY,
  cellHeight
}: {
  baseY: number
  viewportY: number
  startY: number
  endY: number
  cellHeight: number
}): number {
  const deltaY = startY - endY
  if (deltaY > 0 ? viewportY >= baseY : viewportY <= 0) {
    return viewportY
  }
  const smoothScrollOffsetY = -deltaY
  const lines = Math.trunc(-smoothScrollOffsetY / cellHeight)
  const applied = Math.max(lines, -viewportY)
  return viewportY + applied
}
