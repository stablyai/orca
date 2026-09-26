import { describe, expect, it, vi } from 'vitest'
import { throttleRuntimeUploadProgress } from './runtime-upload-progress'

const MB = 1024 * 1024

function collector(now: () => number) {
  const seen: number[] = []
  const emit = throttleRuntimeUploadProgress((progress) => seen.push(progress.sentBytes), now)
  return { seen, emit }
}

describe('throttleRuntimeUploadProgress', () => {
  it('drops updates that are neither big enough nor old enough', () => {
    let clock = 0
    const { seen, emit } = collector(() => clock)
    const total = 100 * MB

    emit({ uploadId: 'u', sentBytes: 512 * 1024, totalBytes: total })
    for (let sent = 768 * 1024; sent <= 1408 * 1024; sent += 256 * 1024) {
      clock += 10
      emit({ uploadId: 'u', sentBytes: sent, totalBytes: total })
    }

    // Only the first: every follow-up is under 1 MB apart and inside 100ms.
    expect(seen).toEqual([512 * 1024])
  })

  it('lets an update through once a megabyte has moved', () => {
    let clock = 0
    const { seen, emit } = collector(() => clock)
    const total = 100 * MB

    emit({ uploadId: 'u', sentBytes: 1, totalBytes: total })
    clock += 5
    emit({ uploadId: 'u', sentBytes: 2 * MB, totalBytes: total })

    expect(seen).toEqual([1, 2 * MB])
  })

  it('lets an update through once the interval has passed on a slow link', () => {
    let clock = 0
    const { seen, emit } = collector(() => clock)
    const total = 100 * MB

    emit({ uploadId: 'u', sentBytes: 1, totalBytes: total })
    clock += 250
    emit({ uploadId: 'u', sentBytes: 1024, totalBytes: total })

    expect(seen).toEqual([1, 1024])
  })

  it('always emits the final byte count so the bar lands on full', () => {
    let clock = 0
    const { seen, emit } = collector(() => clock)
    const total = 4 * MB

    emit({ uploadId: 'u', sentBytes: 1, totalBytes: total })
    clock += 1
    emit({ uploadId: 'u', sentBytes: total, totalBytes: total })

    expect(seen).toEqual([1, total])
  })

  it('emits a zero-byte file exactly once', () => {
    const { seen, emit } = collector(() => 0)

    emit({ uploadId: 'u', sentBytes: 0, totalBytes: 0 })
    emit({ uploadId: 'u', sentBytes: 0, totalBytes: 0 })

    expect(seen).toEqual([0])
  })

  it('never moves the reported count backwards', () => {
    let clock = 0
    const { seen, emit } = collector(() => clock)
    const total = 100 * MB

    emit({ uploadId: 'u', sentBytes: 10 * MB, totalBytes: total })
    clock += 500
    emit({ uploadId: 'u', sentBytes: 4 * MB, totalBytes: total })

    expect(seen).toEqual([10 * MB])
  })

  it('keeps a separate baseline per throttle so two files do not interfere', () => {
    const first = collector(() => 0)
    const second = collector(() => 0)

    first.emit({ uploadId: 'a', sentBytes: 8 * MB, totalBytes: 100 * MB })
    second.emit({ uploadId: 'b', sentBytes: 1, totalBytes: 100 * MB })

    expect(first.seen).toEqual([8 * MB])
    expect(second.seen).toEqual([1])
  })

  it('uses a real clock by default', () => {
    const spy = vi.fn()
    const emit = throttleRuntimeUploadProgress(spy)
    emit({ uploadId: 'u', sentBytes: 1, totalBytes: 10 })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
