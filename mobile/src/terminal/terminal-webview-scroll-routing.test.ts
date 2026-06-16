import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The in-WebView JS lives in terminal-webview-html.ts; the RN wrapper in
// TerminalWebView.tsx. Concatenate both so assertions resolve regardless of file.
const source =
  readFileSync(new URL('./TerminalWebView.tsx', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-html.ts', import.meta.url), 'utf8')
const sessionSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
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
    expect(source).toContain('const pendingWriteBytesRef = useRef(0)')
    expect(source).toContain('const pendingWriteCountRef = useRef(0)')
    expect(source).toContain('const queuePendingMessage = useCallback')
    expect(source).toContain('pendingWriteCountRef.current > MAX_PENDING_WEB_WRITE_MESSAGES')
    expect(source).toContain("candidate.type === 'write'")
    expect(source).toContain('clearPendingMessages()')
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
      '  // ============================================================\n  // LATCHING TOUCH DISPATCHER'
    )
    expect(dragMoveBlock).toContain('edgeScrollClientX = clientX;')
    expect(dragMoveBlock).toContain('edgeScrollClientY = clientY;')
    expect(dragMoveBlock).toContain('syncSelectionHandleToViewportPoint(handle, clientX, clientY)')
  })

  it('synthesizes bounded mouse clicks from surface taps before focus fallback', () => {
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
    // Why: mouse-click synthesis must precede the tap/file-path fallback so a
    // bound mouse mode wins. The fallback now routes through notifyTapOrFilePath
    // (which emits terminal-file-tap on a path, else terminal-tap).
    expect(touchEndBlock.indexOf('var clickInput = buildMouseClickInput')).toBeLessThan(
      touchEndBlock.indexOf('notifyTapOrFilePath(')
    )
    expect(touchEndBlock).toContain("notify({ type: 'terminal-input', bytes: clickInput });")
    expect(touchEndBlock).toContain(
      '} else if (!isClickMouseTrackingMode(getMouseTrackingMode())) {'
    )
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
