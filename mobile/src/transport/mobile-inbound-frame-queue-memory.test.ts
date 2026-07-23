import { describe, expect, it, vi } from 'vitest'
import { createMobileInboundFrameQueue } from './mobile-inbound-frame-queue'
import { createMobileInboundMemoryLedger } from './mobile-inbound-memory-ledger'

function expectEmpty(ledger: ReturnType<typeof createMobileInboundMemoryLedger>): void {
  expect(ledger.evidence()).toMatchObject({ claimCount: 0, retainedBytes: 0 })
}

describe('mobile inbound frame queue aggregate memory', () => {
  it('releases a claim after synchronous processing succeeds', async () => {
    const ledger = createMobileInboundMemoryLedger(10)
    const queue = createMobileInboundFrameQueue({
      process: vi.fn(),
      onError: vi.fn(),
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large',
      memoryLedger: ledger
    })

    await queue.enqueue(new Uint8Array(3))

    expectEmpty(ledger)
  })

  it('releases a claim after synchronous processing throws', async () => {
    const ledger = createMobileInboundMemoryLedger(10)
    const onError = vi.fn()
    const queue = createMobileInboundFrameQueue({
      process: () => {
        throw new Error('processing failed')
      },
      onError,
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large',
      memoryLedger: ledger
    })

    await queue.enqueue(new Uint8Array(3))

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'processing failed' }))
    expectEmpty(ledger)
  })

  it('rejects a frame when another physical queue owns the remaining process credit', async () => {
    const ledger = createMobileInboundMemoryLedger(5)
    let releaseFirst!: () => void
    const first = createMobileInboundFrameQueue({
      process: () => new Promise<void>((resolve) => (releaseFirst = resolve)),
      onError: vi.fn(),
      overflowMessage: 'first overflow',
      frameTooLargeMessage: 'too large',
      memoryLedger: ledger
    })
    const secondProcess = vi.fn()
    const secondError = vi.fn()
    const second = createMobileInboundFrameQueue({
      process: secondProcess,
      onError: secondError,
      overflowMessage: 'aggregate overflow',
      frameTooLargeMessage: 'too large',
      memoryLedger: ledger
    })

    const firstPending = first.enqueue(new Uint8Array(3))
    await second.enqueue(new Uint8Array(3))

    expect(secondProcess).not.toHaveBeenCalled()
    expect(secondError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'aggregate overflow' })
    )
    expect(ledger.evidence()).toMatchObject({ claimCount: 1, retainedBytes: 3 })
    releaseFirst()
    await firstPending
    expectEmpty(ledger)
  })

  it('releases current and queued claims after processing rejects', async () => {
    const ledger = createMobileInboundMemoryLedger(10)
    let rejectCurrent!: (error: Error) => void
    const onError = vi.fn()
    const queue = createMobileInboundFrameQueue({
      process: () => new Promise<void>((_resolve, reject) => (rejectCurrent = reject)),
      onError,
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large',
      memoryLedger: ledger
    })
    const first = queue.enqueue(new Uint8Array(2))
    const second = queue.enqueue(new Uint8Array(3))
    expect(ledger.evidence()).toMatchObject({ claimCount: 2, retainedBytes: 5 })

    rejectCurrent(new Error('processing failed'))
    await Promise.all([first, second])

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'processing failed' }))
    expectEmpty(ledger)
  })

  it('releases queued claims on dispose and the active claim when processing settles', async () => {
    const ledger = createMobileInboundMemoryLedger(10)
    let releaseCurrent!: () => void
    const queue = createMobileInboundFrameQueue({
      process: () => new Promise<void>((resolve) => (releaseCurrent = resolve)),
      onError: vi.fn(),
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large',
      memoryLedger: ledger
    })
    const first = queue.enqueue(new Uint8Array(2))
    const second = queue.enqueue(new Uint8Array(3))

    queue.dispose()
    expect(ledger.evidence()).toMatchObject({ claimCount: 1, retainedBytes: 2 })
    releaseCurrent()
    await Promise.all([first, second])
    expectEmpty(ledger)
  })

  it('releases every claim after per-queue overflow', async () => {
    const ledger = createMobileInboundMemoryLedger(10)
    let releaseCurrent!: () => void
    const queue = createMobileInboundFrameQueue({
      process: () => new Promise<void>((resolve) => (releaseCurrent = resolve)),
      onError: vi.fn(),
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large',
      maxBufferedBytes: 4,
      memoryLedger: ledger
    })
    const first = queue.enqueue(new Uint8Array(3))
    const rejected = queue.enqueue(new Uint8Array(2))

    expect(ledger.evidence()).toMatchObject({ claimCount: 1, retainedBytes: 3 })
    releaseCurrent()
    await Promise.all([first, rejected])
    expectEmpty(ledger)
  })

  it('does not claim process memory for an individually oversized frame', async () => {
    const ledger = createMobileInboundMemoryLedger(10)
    const queue = createMobileInboundFrameQueue({
      process: vi.fn(),
      onError: vi.fn(),
      overflowMessage: 'overflow',
      frameTooLargeMessage: 'too large',
      maxFrameBytes: 2,
      memoryLedger: ledger
    })

    await queue.enqueue(new Uint8Array(3))

    expectEmpty(ledger)
  })
})
