// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelDocumentFrames,
  resetTerminalDocumentScope,
  scheduleDocumentFrame,
  scope
} from './document-scope'

/**
 * The frames the document is owed, and the two things `cancelDocumentFrames` has to do.
 *
 * Taking back the pending ones is the obvious half. The other half is refusing new ones: tearing
 * the terminal down runs the engine's own disposal, which calls back into these modules, and a
 * frame asked for on the way out would be owed by nobody because the cancel has already run. A
 * generation guard cannot help there — it makes a stale frame do nothing, but the frame still
 * runs, and on the page the mount it belonged to may be gone and the next one already up.
 */
describe('the document frame registry', () => {
  afterEach(() => {
    resetTerminalDocumentScope()
    vi.restoreAllMocks()
  })

  it('holds a frame until it runs, then forgets it', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    resetTerminalDocumentScope()

    const id = scheduleDocumentFrame(() => {})
    expect(scope.scheduledFrames).toEqual([id])
    frames[0]!(0)
    expect(scope.scheduledFrames).toEqual([])
  })

  it('takes back every pending frame and then refuses to schedule', () => {
    const cancelled: number[] = []
    let next = 0
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => {
      next += 1
      return next
    })
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => cancelled.push(id))
    resetTerminalDocumentScope()

    const first = scheduleDocumentFrame(() => {})
    const second = scheduleDocumentFrame(() => {})
    cancelDocumentFrames()
    expect(cancelled).toEqual([first, second])
    expect(scope.scheduledFrames).toEqual([])

    const requests = vi.mocked(globalThis.requestAnimationFrame).mock.calls.length
    expect(scheduleDocumentFrame(() => {})).toBe(-1)
    expect(vi.mocked(globalThis.requestAnimationFrame).mock.calls.length).toBe(requests)
    expect(scope.scheduledFrames).toEqual([])
  })

  it('schedules again once the scope is reset, which is what the next mount does', () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 7)
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    resetTerminalDocumentScope()

    cancelDocumentFrames()
    expect(scope.framesStopped).toBe(true)
    resetTerminalDocumentScope()
    expect(scope.framesStopped).toBe(false)
    expect(scheduleDocumentFrame(() => {})).toBe(7)
    expect(scope.scheduledFrames).toEqual([7])
  })
})
