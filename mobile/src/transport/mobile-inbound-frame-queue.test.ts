import { describe, expect, it, vi } from 'vitest'
import { createMobileInboundFrameQueue } from './mobile-inbound-frame-queue'

describe('mobile inbound frame queue', () => {
  it('serializes async processing without losing frame order', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const processed: string[] = []
    const queue = createMobileInboundFrameQueue({
      process: async (raw) => {
        if (raw === 'first') {
          await gate
        }
        processed.push(String(raw))
      },
      onError: vi.fn(),
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large'
    })

    const first = queue.enqueue('first')
    const second = queue.enqueue('second')
    expect(processed).toEqual([])
    release()
    await Promise.all([first, second])
    expect(processed).toEqual(['first', 'second'])
  })

  it('does not retain processed frame slots while a steady stream keeps the queue busy', async () => {
    let releaseCurrent!: () => void
    const queue = createMobileInboundFrameQueue({
      process: () => new Promise<void>((resolve) => (releaseCurrent = resolve)),
      onError: vi.fn(),
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large'
    })
    let current = queue.enqueue({ byteLength: 1, id: 0 })
    let next = queue.enqueue({ byteLength: 1, id: 1 })

    for (let id = 2; id < 256; id += 1) {
      releaseCurrent()
      await current
      current = next
      next = queue.enqueue({ byteLength: 1, id })
      expect(queue.evidence().storageSlots).toBeLessThanOrEqual(64)
    }

    releaseCurrent()
    await current
    releaseCurrent()
    await next
    expect(queue.evidence()).toEqual({ retainedBytes: 0, retainedFrames: 0, storageSlots: 0 })
  })

  it('drops and settles the backlog when retained frame count reaches its cap', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const onError = vi.fn()
    const queue = createMobileInboundFrameQueue({
      process: async () => gate,
      onError,
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large',
      maxBufferedFrames: 2,
      maxBufferedBytes: 100,
      maxFrameBytes: 100
    })

    const pending = [
      queue.enqueue(new Uint8Array(1)),
      queue.enqueue(new Uint8Array(1)),
      queue.enqueue(new Uint8Array(1))
    ]
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'overflow' }))
    release()
    await Promise.all(pending)
  })

  it('fails closed when aggregate retained bytes exceed their cap', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const onError = vi.fn()
    const queue = createMobileInboundFrameQueue({
      process: async () => gate,
      onError,
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large',
      maxBufferedFrames: 10,
      maxBufferedBytes: 5,
      maxFrameBytes: 4
    })

    const first = queue.enqueue(new Uint8Array(3))
    const second = queue.enqueue(new Uint8Array(3))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'overflow' }))
    release()
    await Promise.all([first, second])
  })

  it('rejects a single known oversized frame without invoking its processor', async () => {
    const process = vi.fn()
    const onError = vi.fn()
    const queue = createMobileInboundFrameQueue({
      process,
      onError,
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large',
      maxFrameBytes: 4
    })

    await queue.enqueue(new Uint8Array(5))

    expect(process).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'too large' }))
  })
})
