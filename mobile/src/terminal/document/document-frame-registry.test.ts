// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelDocumentFrames,
  createTerminalDocumentScope,
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
 *
 * These modules read one scope, so a case that needs a fresh document refills it from the same
 * factory the document's own build calls. On the page that is a new object per mount (ruling 22);
 * here it is this object holding what a new one would.
 */
const startAFreshDocument = () => {
  Object.assign(scope, createTerminalDocumentScope())
}
describe('the document frame registry', () => {
  afterEach(() => {
    startAFreshDocument()
    vi.restoreAllMocks()
  })

  it('holds a frame until it runs, then forgets it', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    startAFreshDocument()

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
    startAFreshDocument()

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

  it('refuses for good, and the next document starts from a scope that does not know', () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 7)
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    startAFreshDocument()

    cancelDocumentFrames()
    expect(scope.framesStopped).toBe(true)
    // Nothing clears this flag: a stopped document stays stopped, and what schedules again is the
    // next document's own scope.
    expect(createTerminalDocumentScope().framesStopped).toBe(false)
    startAFreshDocument()
    expect(scheduleDocumentFrame(() => {})).toBe(7)
    expect(scope.scheduledFrames).toEqual([7])
  })
})
