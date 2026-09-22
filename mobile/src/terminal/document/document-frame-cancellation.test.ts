// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import {
  enqueueNormalBufferScrollDelta,
  resetSmoothScrollOffset
} from './normal-buffer-smooth-scroll'
import { attachSurfaceEventHandlers, stopSurfaceTouchGestures } from './surface-touch-gestures'

afterEach(() => vi.restoreAllMocks())

function trackPendingFrames() {
  const pending = new Map<number, FrameRequestCallback>()
  let nextId = 0
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++nextId
    pending.set(id, callback)
    return id
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
    pending.delete(id)
  })
  return pending
}

describe('cancelled document frames', () => {
  it('forgets every interrupted normal-buffer scroll while the document stays mounted', () => {
    const pending = trackPendingFrames()
    const scope = createTerminalDocumentScope()
    const { terminal } = terminalDocumentDouble()
    scope.term = {
      ...terminal,
      buffer: { active: { ...terminal.buffer.active, viewportY: 10, baseY: 20 } }
    }

    for (let cycle = 0; cycle < 100; cycle++) {
      expect(enqueueNormalBufferScrollDelta(scope, 1)).toBe(true)
      resetSmoothScrollOffset(scope)
    }

    expect(pending.size).toBe(0)
    expect(scope.normalScrollFrameId).toBeNull()
    expect(scope.scheduledFrames).toEqual([])
  })

  it.each(['new touch', 'gesture stop'])('forgets momentum cancelled by %s', (cause) => {
    const pending = trackPendingFrames()
    const scope = createTerminalDocumentScope()
    scope.term = terminalDocumentDouble().terminal
    const surface = document.createElement('div')
    attachSurfaceEventHandlers(scope, surface)

    for (let cycle = 0; cycle < 100; cycle++) {
      scope.touchGesture.velY = 1
      surface.dispatchEvent(new TouchEvent('touchend', { touches: [] }))
      expect(pending.size).toBe(1)
      if (cause === 'new touch') {
        surface.dispatchEvent(new TouchEvent('touchstart', { touches: [] }))
      } else {
        stopSurfaceTouchGestures(scope)
      }
    }

    expect(pending.size).toBe(0)
    expect(scope.touchGesture.momentumId).toBeNull()
    expect(scope.scheduledFrames).toEqual([])
  })
})
