// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { cancelDocumentFrames, scheduleDocumentFrame } from './document-frame-registry'

/**
 * The frames the document is owed, and the two things `cancelDocumentFrames` has to do.
 *
 * Taking back the pending ones is the obvious half. The other half is refusing new ones: tearing
 * the terminal down runs the engine's own disposal, which calls back into these modules, and a
 * frame asked for on the way out would be owed by nobody because the cancel has already run. A
 * generation guard cannot help there — it makes a stale frame do nothing, but the frame still
 * runs, and on the page the mount it belonged to may be gone and the next one already up.
 *
 * A scope per case, because that is what a document is now: nothing here can leak into the next
 * case, and nothing has to be reset for it not to.
 */
describe('the document frame registry', () => {
  it('holds a frame until it runs, then forgets it', () => {
    const scope = createTerminalDocumentScope()
    const frames: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })

    const id = scheduleDocumentFrame(scope, () => {})
    expect(scope.scheduledFrames).toEqual([id])
    frames[0]!(0)
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
    // Nothing clears this flag: a stopped document stays stopped, and what schedules again is the
    // next document's own scope.
    const next = createTerminalDocumentScope()
    expect(next.framesStopped).toBe(false)
    expect(scheduleDocumentFrame(next, () => {})).toBe(7)
    expect(next.scheduledFrames).toEqual([7])
    vi.restoreAllMocks()
  })
})
