// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { cancelDocumentFrames, scheduleDocumentFrame } from './document-frame-registry'

// Disposal can call back into document modules; cancellation must remove pending frames and refuse new ones.
describe('the document frame registry', () => {
  it('holds a frame until it runs, then forgets it', () => {
    const scope = createTerminalDocumentScope()
    const frames: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })

    const callback = vi.fn()
    const id = scheduleDocumentFrame(scope, callback)
    expect(callback).not.toHaveBeenCalled()
    expect(scope.scheduledFrames).toEqual([id])
    frames[0]!(123)
    expect(callback).toHaveBeenCalledExactlyOnceWith(123)
    expect(scope.scheduledFrames).toEqual([])
    vi.restoreAllMocks()
  })

  it('takes back every pending frame and then refuses to schedule', () => {
    const scope = createTerminalDocumentScope()
    const cancelled: number[] = []
    let next = 0
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => {
      next += 1
      return next
    })
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => cancelled.push(id))

    const first = scheduleDocumentFrame(scope, () => {})
    const second = scheduleDocumentFrame(scope, () => {})
    cancelDocumentFrames(scope)
    expect(cancelled).toEqual([first, second])
    expect(scope.scheduledFrames).toEqual([])

    const requests = vi.mocked(globalThis.requestAnimationFrame).mock.calls.length
    expect(scheduleDocumentFrame(scope, () => {})).toBe(-1)
    expect(vi.mocked(globalThis.requestAnimationFrame).mock.calls.length).toBe(requests)
    expect(scope.scheduledFrames).toEqual([])
    vi.restoreAllMocks()
  })

  it('refuses for good, and the next document starts from a scope that does not know', () => {
    const scope = createTerminalDocumentScope()
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 7)
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})

    cancelDocumentFrames(scope)
    expect(scope.framesStopped).toBe(true)
    // Stopped scopes never restart; a new document gets a fresh scope.
    const next = createTerminalDocumentScope()
    expect(next.framesStopped).toBe(false)
    expect(scheduleDocumentFrame(next, () => {})).toBe(7)
    expect(next.scheduledFrames).toEqual([7])
    vi.restoreAllMocks()
  })
})
