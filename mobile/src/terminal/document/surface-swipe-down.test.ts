import { describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { reportSwipeDown } from './surface-swipe-down'

function scopeWithGesture(start: { x: number; y: number }, lastMove: { x: number; y: number }) {
  const scope = createTerminalDocumentScope()
  const postToHost = vi.fn()
  scope.postToHost = postToHost
  scope.touchGesture.swipeStartX = start.x
  scope.touchGesture.swipeStartY = start.y
  scope.touchGesture.lastX = lastMove.x
  scope.touchGesture.lastY = lastMove.y
  return { scope, postToHost }
}

const touchAt = (x: number, y: number) => ({ clientX: x, clientY: y }) as Touch

describe('reportSwipeDown', () => {
  it('classifies on the release point, past the last touchmove', () => {
    const { scope, postToHost } = scopeWithGesture({ x: 100, y: 100 }, { x: 100, y: 150 })
    reportSwipeDown(scope, touchAt(102, 170))
    expect(postToHost).toHaveBeenCalledWith({ type: 'terminal-swipe-down' })
    expect(scope.touchGesture.swipeStartY).toBeNull()
  })

  it('ignores a short or mostly sideways swipe', () => {
    const short = scopeWithGesture({ x: 100, y: 100 }, { x: 100, y: 130 })
    reportSwipeDown(short.scope, touchAt(100, 140))
    const sideways = scopeWithGesture({ x: 100, y: 100 }, { x: 160, y: 150 })
    reportSwipeDown(sideways.scope, touchAt(180, 170))
    expect(short.postToHost).not.toHaveBeenCalled()
    expect(sideways.postToHost).not.toHaveBeenCalled()
  })
})
