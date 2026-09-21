import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { XTERM_HTML } from './terminal-webview-html'

// The RN wrapper and the pending-message queue are TypeScript; everything the WebView runs is the
// generated document. Concatenated so assertions resolve regardless of file.
const source =
  readFileSync(new URL('./TerminalWebView.tsx', import.meta.url), 'utf8') +
  readFileSync(new URL('./use-terminal-webview-controller.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-ready-promises.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-pending-messages.ts', import.meta.url), 'utf8') +
  XTERM_HTML
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
  it('keeps Android touch drags inside the terminal WebView', () => {
    expect(source).toContain('nestedScrollEnabled')
  })

  it('maps a downward pull at the bottom to older scrollback rows', () => {
    expect(source).toContain('const deltaY = scope.touchGesture.lastY - y;')
    expect(source).toContain('scope.smoothScrollOffsetY -= deltaY;')
    expect(source).toContain(
      'const lines = Math.trunc(-scope.smoothScrollOffsetY / effectiveCellH);'
    )

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
      'targetSurface.addEventListener(\n      "touchmove"',
      '{ capture: true, passive: false }'
    )
    expect(touchMoveBlock.indexOf('if (shouldRouteScrollToTerminalInput())')).toBeLessThan(
      touchMoveBlock.indexOf('if (enqueueNormalBufferScrollDelta(deltaY))')
    )
    expect(touchMoveBlock).toContain('routeScrollLines(lines, x, y);')

    const momentumBlock = sliceBetween(
      'let momentumStep = function(frameTime)',
      'if (Math.abs(vel) > MIN_VEL)'
    )
    expect(momentumBlock.indexOf('if (shouldRouteScrollToTerminalInput())')).toBeLessThan(
      momentumBlock.indexOf('if (!applyNormalBufferScrollDelta(delta))')
    )
    expect(momentumBlock).toContain(
      'routeScrollLines(lines, scope.touchGesture.lastX, scope.touchGesture.lastY);'
    )
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
      'targetSurface.addEventListener(\n      "touchmove"',
      '{ capture: true, passive: false }'
    )
    expect(touchMoveBlock).toContain('if (enqueueNormalBufferScrollDelta(deltaY))')
    expect(touchMoveBlock).toContain('scope.touchGesture.velY = 0;')

    const momentumBlock = sliceBetween(
      'let momentumStep = function(frameTime)',
      'if (Math.abs(vel) > MIN_VEL)'
    )
    expect(momentumBlock).toContain('if (!applyNormalBufferScrollDelta(delta))')
    expect(momentumBlock).toContain('scope.touchGesture.momentumId = null;')
  })

  it('coalesces normal touch scroll row commits onto animation frames', () => {
    const enqueueBlock = sliceBetween(
      'function enqueueNormalBufferScrollDelta(deltaY)',
      'function resetSmoothScrollOffset()'
    )
    expect(enqueueBlock).toContain('scope.pendingNormalScrollDeltaY += deltaY;')
    expect(enqueueBlock).toContain('if (scope.normalScrollFrameId !== null) {')
    // Ruling 21: every document frame goes through the scope's registry so dispose can take it
    // back; the id is still held here, which is what the reset below cancels.
    expect(enqueueBlock).toContain('scope.normalScrollFrameId = scheduleDocumentFrame(function()')
    expect(enqueueBlock).toContain('applyNormalBufferScrollDelta(delta)')

    const resetBlock = sliceBetween(
      'function resetSmoothScrollOffset()',
      'function cellToViewportPx'
    )
    expect(resetBlock).toContain('scope.pendingNormalScrollDeltaY = 0;')
    expect(resetBlock).toContain('cancelAnimationFrame(scope.normalScrollFrameId);')
  })

  it('drains terminal writes without shifting the queued array', () => {
    expect(source).toContain('scope.writeQueueHead = 0;')
    expect(source).toContain('function nextQueuedWrite()')
    expect(source).toContain('scope.writeQueueHead++;')
    expect(source).toContain('scope.writeQueue = scope.writeQueue.slice(scope.writeQueueHead);')
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
    // C7.5 moved both promises into `terminal-webview-ready-promises.ts`, which both components
    // reach through the controller; the two blocks are the same code in their new home.
    const measureBlock = sliceBetween('function measure(', 'function resolveMeasure')
    expect(measureBlock).toContain('clearTimeout(timeout)')
    expect(measureBlock).toContain('measureResolve === finish')

    const readyBlock = sliceBetween('async function awaitReady()', 'function measure(')
    expect(readyBlock).toContain('clearTimeout(timeout)')
    expect(readyBlock).toContain('void pending.finally')
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
      'scope.surface.style.transform = "translate(" + scope.panX + "px," + scope.panY + "px) scale(" + getTotalScale() + ")"'
    )
    expect(source).not.toContain("querySelector('.xterm-screen')")
    expect(source).not.toContain('updateTerminalScreenTransform')
    expect(updateTransformBlock).not.toContain('getVisualPanY() + "px) scale("')
    expect(updateTransformBlock).not.toContain('smoothScrollOffsetY')
  })

  it('smooths velocity samples and uses lower friction for mobile momentum', () => {
    expect(source).toContain('function updateTouchVelocity(deltaY, dt)')
    expect(source).toContain('scope.touchGesture.velY * 0.55 + instantVelocity * 0.45')
    expect(source).toContain('const FRICTION = 0.972;')
    expect(source).toContain('const MIN_VEL = 0.012;')
    expect(source).toContain('let lastMomentumTime = performance.now();')
    expect(source).toContain(
      'const elapsed = Math.max(1, Math.min(50, frameTime - lastMomentumTime));'
    )
    expect(source).toContain('vel *= FRICTION ** (elapsed / 16);')
    expect(source).toContain('const delta = vel * elapsed;')
  })

  it('keeps selection edge autoscroll active and extends the dragged endpoint', () => {
    const startBlock = sliceBetween('function startEdgeScroll(dir)', 'function stopEdgeScroll()')
    expect(startBlock.indexOf('stopEdgeScroll();')).toBeLessThan(
      startBlock.indexOf('scope.edgeScrollDir = dir;')
    )
    expect(startBlock.indexOf('scope.term.scrollLines(scope.edgeScrollDir);')).toBeLessThan(
      startBlock.indexOf('syncEdgeScrollSelectionEndpoint();')
    )

    const dragMoveBlock = sliceBetween(
      'function handleDragMove(handle, clientX, clientY)',
      'function attachSurfaceEventHandlers('
    )
    expect(dragMoveBlock).toContain('scope.edgeScrollClientX = clientX;')
    expect(dragMoveBlock).toContain('scope.edgeScrollClientY = clientY;')
    expect(dragMoveBlock).toContain('syncSelectionHandleToViewportPoint(handle, clientX, clientY)')
  })

  it('opens links and paths from surface taps before mouse/focus fallback', () => {
    expect(source).toContain('function buildMouseClickInput(clientX, clientY)')
    expect(source).toContain('function isClickMouseTrackingMode(mode)')
    expect(source).toContain('return mode !== "none";')
    expect(source).toContain('const pixelX = cell.x;')
    expect(source).toContain('const pixelY = cell.y;')
    expect(source).toContain(
      'if (!isSafeSgrMouseCoordinate(cell.x) || !isSafeSgrMouseCoordinate(cell.y)) {'
    )
    expect(source).toContain(
      'if (!isSafeSgrMouseCoordinate(sgrCol) || !isSafeSgrMouseCoordinate(sgrRow)) {'
    )
    expect(source).toContain('if (mouseTrackingMode === "x10") {\n        return pixelPress;')
    expect(source).toContain('if (mouseTrackingMode === "x10") {\n        return sgrPress;')
    expect(source).toContain('if (mouseTrackingMode === "x10") {\n      return press;')
    expect(source).toContain('if (col > 126 || row > 126) {\n      return "";')

    const touchEndBlock = sliceBetween('function onDocumentTouchEnd(e)', '\n  function ')
    expect(touchEndBlock).toContain(
      'notifyTerminalSurfaceTap(scope.tapCandidate.x, scope.tapCandidate.y, true)'
    )

    const tapHandlerBlock = sliceBetween(
      'function notifyTerminalSurfaceTap(originX, originY, focusKeyboard)',
      'function onDocumentTouchStart(e)'
    )
    expect(tapHandlerBlock.indexOf('oscLinkAtViewportPoint')).toBeLessThan(
      tapHandlerBlock.indexOf('urlAtViewportPoint')
    )
    expect(tapHandlerBlock.indexOf('urlAtViewportPoint')).toBeLessThan(
      tapHandlerBlock.indexOf('filePathAtViewportPoint')
    )
    expect(tapHandlerBlock.indexOf('filePathAtViewportPoint')).toBeLessThan(
      tapHandlerBlock.indexOf('const clickInput = buildMouseClickInput')
    )
    expect(tapHandlerBlock).toContain('notify({ type: "open-url", url: tappedUrl });')
    expect(tapHandlerBlock).toContain('notify({ type: "terminal-input", bytes: clickInput });')
    expect(tapHandlerBlock).toContain(
      'if (focusKeyboard || !isClickMouseTrackingMode(getMouseTrackingMode()))'
    )
    expect(tapHandlerBlock).toContain('notify({ type: "terminal-tap" });')
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
