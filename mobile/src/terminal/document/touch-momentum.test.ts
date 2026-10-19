// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { releaseTouchMomentum, startTouchMomentum, updateTouchVelocity } from './touch-momentum'
import { stopSurfaceTouchGestures } from './surface-touch-gestures'
import { cancelDocumentFrames } from './document-frame-registry'
import { routeTouchTravelToTerminal } from './tui-wheel-pacing'

describe('touch momentum elapsed time', () => {
  let now: number
  let nextId: number
  let frames: Map<number, FrameRequestCallback>

  beforeEach(() => {
    now = 1_000
    nextId = 1
    frames = new Map()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextId++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function scrollingScope(profile?: 'one-row' | 'claude-code') {
    const scope = createTerminalDocumentScope()
    const terminal = terminalDocumentDouble().terminal
    const buffer = {
      ...terminal.buffer.active,
      baseY: 1_000,
      viewportY: 500,
      type: profile ? 'alternate' : 'normal'
    }
    scope.term = Object.assign(terminal, {
      buffer: { active: buffer },
      modes: { mouseTrackingMode: profile ? 'vt200' : 'none' },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } },
      scrollLines(lines: number) {
        buffer.viewportY += lines
      },
      setViewportPixelOffset() {
        return true
      }
    })
    return scope
  }

  function frameAfter(ms: number) {
    now += ms
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(now))
  }

  /**
   * A coast over a program's screen, where every whole row of its travel is one wheel report and
   * the remainder stays in `accumDelta`, so the distance is exactly what the coast integrated.
   */
  function coast(frameMs: number, durationMs: number, velocity = 1) {
    frames.clear()
    const scope = scrollingScope('one-row')
    scope.mouseEncodingKnown = true
    scope.sgrMouseMode = true
    let rows = 0
    scope.postToHost = (message) => {
      if (message.type === 'terminal-input' && typeof message.bytes === 'string') {
        rows += message.bytes.split('\u001b[<65;').length - 1
        rows -= message.bytes.split('\u001b[<64;').length - 1
      }
    }
    startTouchMomentum(scope, velocity)
    for (let time = 0; time < durationMs; time += frameMs) {
      frameAfter(Math.min(frameMs, durationMs - time))
    }
    return { scope, distance: rows * 15 + scope.touchGesture.accumDelta }
  }

  function heldTravelScope() {
    const scope = scrollingScope('claude-code')
    scope.mouseEncodingKnown = true
    scope.sgrMouseMode = true
    scope.tuiWheelProfile = 'claude-code'
    scope.touchGesture.lastX = 40
    scope.touchGesture.lastY = 100
    scope.touchGesture.accumDelta = 30
    scope.lastTuiWheelReportAt = now - 32
    const writes: string[] = []
    scope.postToHost = (message) => {
      if (message.type === 'terminal-input' && typeof message.bytes === 'string') {
        writes.push(message.bytes)
      }
    }
    expect(routeTouchTravelToTerminal(scope, 40, 100)).toBe(false)
    expect(frames.size).toBe(1)
    return { scope, writes }
  }

  it('sends held travel once the ambiguous gap expires without more finger movement', () => {
    const { scope, writes } = heldTravelScope()
    frameAfter(16)
    expect(writes).toHaveLength(0)
    frameAfter(16)
    expect(writes).toHaveLength(1)
    expect(scope.touchGesture.accumDelta).toBe(-15)
    expect(frames.size).toBe(0)
    frameAfter(1_000)
    expect(writes).toHaveLength(1)
  })

  it('cancels deferred input when the gesture stops', () => {
    const { scope, writes } = heldTravelScope()
    stopSurfaceTouchGestures(scope)
    expect(scope.scheduledFrames).toHaveLength(0)
    frameAfter(1_000)
    expect(writes).toHaveLength(0)
    expect(frames.size).toBe(0)
  })

  it('cancels deferred input when the terminal document is disposed', () => {
    const { scope, writes } = heldTravelScope()
    cancelDocumentFrames(scope)
    frameAfter(1_000)
    expect(writes).toHaveLength(0)
    expect(frames.size).toBe(0)
  })

  it('does not deliver held program input into a normal buffer after a mode change', () => {
    const { scope, writes } = heldTravelScope()
    Object.assign(scope.term!, {
      buffer: { active: { ...scope.term!.buffer.active, type: 'normal' } },
      modes: { mouseTrackingMode: 'none' }
    })
    frameAfter(100)
    expect(writes).toHaveLength(0)
    expect(frames.size).toBe(0)
  })

  it('hands the deferred travel to momentum through one frame loop', () => {
    const { scope } = heldTravelScope()
    startTouchMomentum(scope, 1)
    expect(scope.touchGesture.pendingWheelFrameId).toBeNull()
    expect(frames.size).toBe(1)
    stopSurfaceTouchGestures(scope)
  })

  it('travels the same distance in a second at 120Hz, 60Hz and delayed 10Hz frames', () => {
    const fast = coast(1_000 / 120, 1_000).distance
    const normal = coast(1_000 / 60, 1_000).distance
    const delayed = coast(100, 1_000).distance
    expect(fast).toBeGreaterThan(420)
    expect(fast).toBeLessThan(440)
    expect(normal).toBeCloseTo(fast, 5)
    expect(delayed).toBeCloseTo(fast, 5)
  })

  it('accounts for travel before a delayed frame crosses the stopping speed', () => {
    const regular = coast(16, 4_000)
    const stalled = coast(4_000, 4_000)
    // A program's coast ends at a row per 120ms: (1 - 0.125) / -ln(0.998) px.
    expect(regular.distance).toBeGreaterThan(430)
    expect(stalled.distance).toBeCloseTo(regular.distance, 5)
    expect(stalled.scope.touchGesture.momentumId).toBeNull()
    expect(frames.size).toBe(0)
  })

  it('keeps a reverse fling independent of frame cadence', () => {
    expect(coast(100, 1_000, -1).distance).toBeCloseTo(coast(16, 1_000, -1).distance, 5)
  })

  it('does not move after a touch takes back the pending coast', () => {
    const scope = scrollingScope()
    startTouchMomentum(scope, 1)
    frameAfter(16)
    const before = { row: scope.term!.buffer.active.viewportY, offset: scope.smoothScrollOffsetY }
    stopSurfaceTouchGestures(scope)
    frameAfter(1_000)
    expect(scope.term!.buffer.active.viewportY).toBe(before.row)
    expect(scope.smoothScrollOffsetY).toBe(before.offset)
    expect(scope.touchGesture.momentumId).toBeNull()
    expect(frames.size).toBe(0)
  })

  it('does not turn a zero-time callback into a boundary bounce', () => {
    const scope = scrollingScope()
    startTouchMomentum(scope, 1)
    frameAfter(0)
    expect(scope.term!.buffer.active.viewportY).toBe(500)
    expect(scope.smoothScrollOffsetY).toBe(0)
    expect(scope.overscrollFrameId).toBeNull()
    expect(frames.size).toBe(1)
    frameAfter(16)
    expect(scope.term!.buffer.active.viewportY).toBeGreaterThan(500)
  })

  it.each(['one-row', 'claude-code'] as const)(
    'keeps delayed %s travel across bounded wire writes',
    (profile) => {
      const scope = scrollingScope(profile)
      scope.mouseEncodingKnown = true
      scope.sgrMouseMode = true
      scope.tuiWheelProfile = profile
      scope.touchGesture.lastX = 40
      scope.touchGesture.lastY = 100
      const writes: { at: number; count: number }[] = []
      scope.postToHost = (msg) => {
        if (msg.type === 'terminal-input' && typeof msg.bytes === 'string') {
          writes.push({ at: now, count: msg.bytes.split('\u001b[<65;').length - 1 })
        }
      }
      startTouchMomentum(scope, 3)
      frameAfter(4_000)
      for (let i = 0; i < 12 && frames.size > 0; i++) {
        frameAfter(16)
      }
      let previous = Number.NEGATIVE_INFINITY
      let moved = 0
      for (const write of writes) {
        expect(write.count).toBeLessThanOrEqual(32)
        moved += write.count + (profile === 'claude-code' && write.at - previous > 40 ? 2 : 0)
        previous = write.at
      }
      expect(moved).toBeGreaterThan(90)
      expect(moved).toBeLessThan(100)
      expect(Math.abs(scope.touchGesture.accumDelta)).toBeLessThan(15)
      expect(scope.touchGesture.momentumId).toBeNull()
      expect(frames.size).toBe(0)
    }
  )
})

describe('touch scroll velocity history', () => {
  it.each([0, 1, -1])('does not revive a fast scroll after a pause and %dpx move', (delta) => {
    const scope = createTerminalDocumentScope()
    updateTouchVelocity(scope, 32, 16)
    expect(scope.touchGesture.velY).toBe(2)
    updateTouchVelocity(scope, delta, 500)
    expect(Math.abs(scope.touchGesture.velY)).toBeLessThan(0.012)
  })

  it('keeps recent samples blended without a discontinuous jump', () => {
    const scope = createTerminalDocumentScope()
    updateTouchVelocity(scope, 32, 16)
    updateTouchVelocity(scope, 16, 16)
    expect(scope.touchGesture.velY).toBeGreaterThan(1)
    expect(scope.touchGesture.velY).toBeLessThan(2)
  })

  it('accepts a new fast movement after the paused history ends', () => {
    const scope = createTerminalDocumentScope()
    updateTouchVelocity(scope, 32, 16)
    updateTouchVelocity(scope, 1, 500)
    updateTouchVelocity(scope, -32, 16)
    expect(scope.touchGesture.velY).toBeLessThan(-0.8)
  })

  it('does not contaminate the next valid sample with invalid intervals or deltas', () => {
    const scope = createTerminalDocumentScope()
    updateTouchVelocity(scope, 32, 16)
    for (const [delta, dt] of [
      [2, 0],
      [2, -1],
      [Number.NaN, 16],
      [2, Number.NaN]
    ]) {
      updateTouchVelocity(scope, delta, dt)
      expect(scope.touchGesture.velY).toBe(2)
    }
  })
})

describe('the release of a touch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([
    [16, true],
    [500, false]
  ])('coasts after the last move %dms before lifting: %s', (sinceLastMove, coasts) => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    const scope = createTerminalDocumentScope()
    scope.touchGesture.velY = 2
    scope.touchGesture.lastTime = 10_000 - sinceLastMove
    releaseTouchMomentum(scope)
    expect(scope.touchGesture.momentumId !== null).toBe(coasts)
  })
})
