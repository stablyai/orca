import { afterEach, describe, expect, it } from 'vitest'
import {
  cancelRuntimeUpload,
  forgetRuntimeUploadCancellation,
  forgetRuntimeUploadCancellationsForSender,
  isRuntimeUploadCancelled,
  isUploadCancelled,
  registerCancellableUpload,
  RuntimeUploadCancelledError,
  scopeRuntimeUploadId
} from './runtime-upload-cancellation'

afterEach(() => {
  forgetRuntimeUploadCancellation('u')
  forgetRuntimeUploadCancellation('v')
})

describe('runtime upload cancellation', () => {
  it('aborts an upload that is already running', () => {
    const upload = registerCancellableUpload('u')
    expect(upload.signal.aborted).toBe(false)

    cancelRuntimeUpload('u')

    expect(upload.signal.aborted).toBe(true)
    upload.release()
  })

  it('aborts the next file when cancel lands between two files of one drop', () => {
    const first = registerCancellableUpload('u')
    first.release()
    cancelRuntimeUpload('u')

    const second = registerCancellableUpload('u')

    expect(second.signal.aborted).toBe(true)
    second.release()
  })

  it('leaves other uploads running', () => {
    const target = registerCancellableUpload('u')
    const bystander = registerCancellableUpload('v')

    cancelRuntimeUpload('u')

    expect(target.signal.aborted).toBe(true)
    expect(bystander.signal.aborted).toBe(false)
    target.release()
    bystander.release()
  })

  it('stops applying a cancel once the drop is forgotten', () => {
    cancelRuntimeUpload('u')
    forgetRuntimeUploadCancellation('u')

    const fresh = registerCancellableUpload('u')
    expect(isUploadCancelled('u')).toBe(false)
    expect(fresh.signal.aborted).toBe(false)
    fresh.release()
  })

  it('releasing a superseded registration does not evict the live one', () => {
    const stale = registerCancellableUpload('u')
    const live = registerCancellableUpload('u')
    stale.release()

    cancelRuntimeUpload('u')

    expect(live.signal.aborted).toBe(true)
    live.release()
  })

  it('keeps windows apart even when they mint the same id', () => {
    expect(scopeRuntimeUploadId(1, 'u')).not.toBe(scopeRuntimeUploadId(2, 'u'))
  })

  it("forgets a gone renderer's remembered cancels and only that renderer's", () => {
    cancelRuntimeUpload(scopeRuntimeUploadId(1, 'u'))
    cancelRuntimeUpload(scopeRuntimeUploadId(2, 'u'))

    forgetRuntimeUploadCancellationsForSender(1)

    expect(isUploadCancelled(scopeRuntimeUploadId(1, 'u'))).toBe(false)
    expect(isUploadCancelled(scopeRuntimeUploadId(2, 'u'))).toBe(true)
    forgetRuntimeUploadCancellation(scopeRuntimeUploadId(2, 'u'))
  })

  it('keeps a live upload aborted if its drop is released mid-flight', () => {
    const live = registerCancellableUpload('u')
    cancelRuntimeUpload('u')
    forgetRuntimeUploadCancellation('u')

    expect(live.signal.aborted).toBe(true)
    live.release()
  })

  it('keeps a live registration cancellable after its remembered cancel is released', () => {
    const live = registerCancellableUpload('u')
    forgetRuntimeUploadCancellation('u')

    cancelRuntimeUpload('u')

    expect(live.signal.aborted).toBe(true)
    live.release()
  })

  it('recognises its own error and nothing else', () => {
    expect(isRuntimeUploadCancelled(new RuntimeUploadCancelledError())).toBe(true)
    expect(isRuntimeUploadCancelled(new Error('disk full'))).toBe(false)
    expect(isRuntimeUploadCancelled('cancelled')).toBe(false)
  })
})
