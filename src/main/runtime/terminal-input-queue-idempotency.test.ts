import { describe, expect, it, vi } from 'vitest'
import { TerminalInputQueueIdempotency } from './terminal-input-queue-idempotency'

describe('terminal input queue idempotency', () => {
  it('shares an in-flight operation and writes once', async () => {
    let finish!: () => void
    const write = vi.fn(
      () =>
        new Promise<{ accepted: boolean }>((resolve) => {
          finish = () => resolve({ accepted: true })
        })
    )
    const idempotency = new TerminalInputQueueIdempotency()

    const first = idempotency.run('mobile-1', 'queue-1', 1, 'fingerprint-a', write)
    const retry = idempotency.run('mobile-1', 'queue-1', 1, 'fingerprint-a', write)

    expect(write).toHaveBeenCalledOnce()
    finish()
    await expect(first).resolves.toEqual({ accepted: true })
    await expect(retry).resolves.toEqual({ accepted: true })
  })

  it('replays a settled acknowledgement without writing twice', async () => {
    const write = vi.fn().mockResolvedValue({ accepted: true, bytesWritten: 3 })
    const idempotency = new TerminalInputQueueIdempotency()

    await idempotency.run('mobile-1', 'queue-1', 1, 'fingerprint-a', write)
    await expect(
      idempotency.run('mobile-1', 'queue-1', 1, 'fingerprint-a', write)
    ).resolves.toEqual({ accepted: true, bytesWritten: 3 })

    expect(write).toHaveBeenCalledOnce()
  })

  it('replays a settled rejection without retrying a possibly partial write', async () => {
    const write = vi.fn().mockRejectedValue(new Error('write failed after delivery'))
    const idempotency = new TerminalInputQueueIdempotency()

    await expect(idempotency.run('mobile-1', 'queue-1', 1, 'fingerprint-a', write)).rejects.toThrow(
      'write failed after delivery'
    )
    await expect(idempotency.run('mobile-1', 'queue-1', 1, 'fingerprint-a', write)).rejects.toThrow(
      'write failed after delivery'
    )

    expect(write).toHaveBeenCalledOnce()
  })

  it('rejects payload reuse and sequence gaps without writing', async () => {
    const write = vi.fn().mockResolvedValue({ accepted: true })
    const idempotency = new TerminalInputQueueIdempotency()
    await idempotency.run('mobile-1', 'queue-1', 1, 'fingerprint-a', write)

    await expect(idempotency.run('mobile-1', 'queue-1', 1, 'fingerprint-b', write)).rejects.toThrow(
      'terminal_input_queue_payload_conflict'
    )
    await expect(idempotency.run('mobile-1', 'queue-1', 3, 'fingerprint-c', write)).rejects.toThrow(
      'terminal_input_queue_sequence_gap'
    )
    expect(write).toHaveBeenCalledOnce()
  })

  it('isolates identical queue IDs by authenticated mobile identity', async () => {
    const write = vi.fn().mockResolvedValue({ accepted: true })
    const idempotency = new TerminalInputQueueIdempotency()

    await idempotency.run('mobile-1', 'queue-1', 1, 'fingerprint-a', write)
    await idempotency.run('mobile-2', 'queue-1', 1, 'fingerprint-a', write)

    expect(write).toHaveBeenCalledTimes(2)
  })

  it('resumes from the first sequence observed after host state restarts', async () => {
    const write = vi.fn().mockResolvedValue({ accepted: true })
    const restartedIdempotency = new TerminalInputQueueIdempotency()

    await restartedIdempotency.run('mobile-1', 'queue-1', 7, 'fingerprint-g', write)
    await restartedIdempotency.run('mobile-1', 'queue-1', 8, 'fingerprint-h', write)

    expect(write).toHaveBeenCalledTimes(2)
  })
})
