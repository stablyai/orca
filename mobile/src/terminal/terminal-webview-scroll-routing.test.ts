import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { webviewPageSource } from './document/document-module-source.test-support'

const DOCUMENT_SOURCE = webviewPageSource()

// The RN wrapper and the pending-message queue are TypeScript; everything the WebView runs is the
// generated document. Concatenated so assertions resolve regardless of file.
const source =
  readFileSync(new URL('./TerminalWebView.tsx', import.meta.url), 'utf8') +
  readFileSync(new URL('./use-terminal-webview-controller.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-ready-promises.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-pending-messages.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-html/document-markup.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('./terminal-webview-html/document-style.ts', import.meta.url), 'utf8') +
  DOCUMENT_SOURCE
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
    expect(source).toContain('const deltaY = scope.touchGesture.lastY - y')
    expect(source).toContain('scope.smoothScrollOffsetY -= deltaY')
    expect(source).toContain(
      'const lines = Math.trunc(-scope.smoothScrollOffsetY / effectiveCellH)'
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
      'return isWheelMouseTrackingMode(getMouseTrackingMode(scope)) || isAlternateBufferActive(scope)'
    )

    const touchMoveBlock = sliceBetween(
      "targetSurface.addEventListener(\n    'touchmove'",
      '{ capture: true, passive: false }'
    )
    expect(touchMoveBlock.indexOf('if (shouldRouteScrollToTerminalInput(scope))')).toBeLessThan(
      touchMoveBlock.indexOf('if (enqueueNormalBufferScrollDelta(scope, deltaY))')
    )
    expect(touchMoveBlock).toContain('routeScrollLines(scope, lines, x, y)')

    const momentumBlock = sliceBetween(
      'function momentumStep(frameTime: number) {',
      'if (Math.abs(vel) > MIN_VEL)'
    )
    expect(momentumBlock.indexOf('if (shouldRouteScrollToTerminalInput(scope))')).toBeLessThan(
      momentumBlock.indexOf('if (!applyNormalBufferScrollDelta(scope, delta))')
    )
    expect(momentumBlock).toContain(
      'routeScrollLines(scope, lines, scope.touchGesture.lastX, scope.touchGesture.lastY)'
    )
  })

  it('does not rubber-band normal scroll at scrollback edges', () => {
    expect(source).toContain('export function canScrollNormalBufferDelta(')
    const smoothScrollBlock = sliceBetween(
      'export function applyNormalBufferScrollDelta(',
      'export function enqueueNormalBufferScrollDelta('
    )
    expect(smoothScrollBlock).toContain('if (!canScrollNormalBufferDelta(scope, deltaY))')
    expect(smoothScrollBlock).toContain('resetSmoothScrollOffset(scope)')
    expect(smoothScrollBlock).toContain('return false')
    expect(smoothScrollBlock).toContain('return true')

    const touchMoveBlock = sliceBetween(
      "targetSurface.addEventListener(\n    'touchmove'",
      '{ capture: true, passive: false }'
    )
    expect(touchMoveBlock).toContain('if (enqueueNormalBufferScrollDelta(scope, deltaY))')
    expect(touchMoveBlock).toContain('scope.touchGesture.velY = 0')

    const momentumBlock = sliceBetween(
      'function momentumStep(frameTime: number) {',
      'if (Math.abs(vel) > MIN_VEL)'
    )
    expect(momentumBlock).toContain('if (!applyNormalBufferScrollDelta(scope, delta))')
    expect(momentumBlock).toContain('scope.touchGesture.momentumId = null')
  })

  it('coalesces normal touch scroll row commits onto animation frames', () => {
    const enqueueBlock = sliceBetween(
      'export function enqueueNormalBufferScrollDelta(',
      'export function resetSmoothScrollOffset('
    )
    expect(enqueueBlock).toContain('scope.pendingNormalScrollDeltaY += deltaY')
    expect(enqueueBlock).toContain('if (scope.normalScrollFrameId !== null) {')
    // Ruling 21: every document frame goes through the scope's registry so dispose can take it
    // back; the id is still held here, which is what the reset below cancels.
    expect(enqueueBlock).toContain(
      'scope.normalScrollFrameId = scheduleDocumentFrame(scope, function () {'
    )
    expect(enqueueBlock).toContain('applyNormalBufferScrollDelta(scope, delta)')

    const resetBlock = sliceBetween(
      'export function resetSmoothScrollOffset(',
      'export function stopNormalBufferSmoothScroll('
    )
    expect(resetBlock).toContain('scope.pendingNormalScrollDeltaY = 0')
    expect(resetBlock).toContain('cancelAnimationFrame(scope.normalScrollFrameId)')
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
    expect(source).toContain('overflow-y: hidden !important')
    expect(source).toContain('display: none !important')
    expect(source).toContain('export function updateScrollIndicator(')
    expect(source).toContain('buffer.viewportY / maxViewportY')
    expect(source).not.toContain('fractionalRows')
    expect(source).toContain('scrollThumb.style.transform =')
    expect(source).toContain('updateScrollIndicator(scope, true)')
  })

  it('does not apply fractional smooth scroll transforms to terminal content', () => {
    const updateTransformBlock = sliceBetween(
      'export function updateTransform(',
      'export function updateScrollIndicator('
    )
    expect(updateTransformBlock).toContain(
      "'translate(' + scope.panX + 'px,' + scope.panY + 'px) scale(' + getTotalScale(scope) + ')'"
    )
    expect(source).not.toContain("querySelector('.xterm-screen')")
    expect(source).not.toContain('updateTerminalScreenTransform')
    expect(updateTransformBlock).not.toContain('getVisualPanY() + "px) scale("')
    expect(updateTransformBlock).not.toContain('smoothScrollOffsetY')
  })

  it('smooths velocity samples and uses lower friction for mobile momentum', () => {
    expect(source).toContain('export function updateTouchVelocity(')
    expect(source).toContain('scope.touchGesture.velY * 0.55 + instantVelocity * 0.45')
    expect(source).toContain('const FRICTION = 0.972')
    expect(source).toContain('const MIN_VEL = 0.012')
    // #21687: the decay is per elapsed millisecond, so a 120 Hz screen coasts the same distance.
    expect(source).toContain('let lastMomentumTime = performance.now()')
    expect(source).toContain(
      'const elapsed = Math.max(1, Math.min(50, frameTime - lastMomentumTime))'
    )
    expect(source).toContain('vel *= FRICTION ** (elapsed / 16)')
    expect(source).toContain('const delta = vel * elapsed')
  })

  it('keeps selection edge autoscroll active and extends the dragged endpoint', () => {
    const startBlock = sliceBetween(
      'export function startEdgeScroll(',
      'export function stopEdgeScroll('
    )
    expect(startBlock.indexOf('stopEdgeScroll(scope)')).toBeLessThan(
      startBlock.indexOf('scope.edgeScrollDir = dir')
    )
    expect(startBlock.indexOf('scope.term.scrollLines(scope.edgeScrollDir)')).toBeLessThan(
      startBlock.indexOf('syncEdgeScrollSelectionEndpoint(scope)')
    )

    const dragMoveBlock = sliceBetween(
      'export function handleDragMove(',
      'function attachSurfaceEventHandlers('
    )
    expect(dragMoveBlock).toContain('scope.edgeScrollClientX = clientX')
    expect(dragMoveBlock).toContain('scope.edgeScrollClientY = clientY')
    expect(dragMoveBlock).toContain(
      'syncSelectionHandleToViewportPoint(scope, handle, clientX, clientY)'
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
