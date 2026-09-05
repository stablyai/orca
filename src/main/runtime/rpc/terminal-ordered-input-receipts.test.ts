import { describe, expect, it, vi } from 'vitest'
import { TerminalOrderedInputReceipts } from './methods/terminal/terminal-ordered-input-receipts'
import type { TerminalInputReceipt } from '../../../shared/terminal-ordered-input'
import { RuntimeRpcCallQueuePool } from '../../../shared/runtime-rpc-call-queue'

function harness(
  write: (text: string) => Promise<Omit<TerminalInputReceipt, 'sequence'>>,
  limits?: { maxFrameBytes: number; maxPendingBytes: number; maxPendingFrames: number }
) {
  const receipts: TerminalInputReceipt[] = []
  const queue = new RuntimeRpcCallQueuePool(1)
  let closed = false
  const stream = new TerminalOrderedInputReceipts({
    write,
    limits,
    isClosed: () => closed,
    close: () => {
      closed = true
    },
    receipt: (receipt) => receipts.push(receipt),
    enqueue: (bytes, run) => queue.enqueue('pty', 'terminal.send', run, bytes * 2)
  })
  return {
    receipts,
    stream,
    close: () => {
      closed = true
    },
    send: (seq: number, text: string) => stream.receive(seq, new TextEncoder().encode(text))
  }
}

describe('negotiated terminal input receipts', () => {
  it('classifies an unexpected write exception as unknown and blocks its suffix', async () => {
    const write = vi.fn(async () => {
      throw new Error('partial provider write')
    })
    const test = harness(write)
    test.send(1, 'text')
    test.send(2, '\r')
    await vi.waitFor(() => expect(test.receipts).toHaveLength(2))
    expect(test.receipts[0]).toMatchObject({ outcome: 'unknown', reason: 'write_failed' })
    expect(test.receipts[1]).toMatchObject({ reason: 'dependency_failed' })
    expect(write).toHaveBeenCalledOnce()
  })

  it('bounds aggregate UTF-8 bytes independently of the frame-count limit', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const test = harness(
      async () => {
        await gate
        return { outcome: 'accepted' }
      },
      { maxFrameBytes: 8, maxPendingBytes: 5, maxPendingFrames: 64 }
    )
    test.send(1, '🙂')
    test.send(2, 'é')
    expect(test.receipts).toEqual([{ sequence: 2, outcome: 'rejected', reason: 'queue_full' }])
    release()
    await vi.waitFor(() => expect(test.receipts).toHaveLength(2))
  })
  it('writes exact control and UTF-8 text, correlating input rather than output sequence', async () => {
    const write = vi.fn(async () => ({ outcome: 'accepted' as const }))
    const test = harness(write)
    const text = '\ufeffabc\u0000é🙂\u001b[A\r'
    test.send(1, text)
    await vi.waitFor(() => expect(test.receipts).toEqual([{ sequence: 1, outcome: 'accepted' }]))
    expect(write).toHaveBeenCalledWith(text)
  })

  it.each(['rejected', 'unknown'] as const)(
    'blocks already pipelined Enter after %s text',
    async (outcome) => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const write = vi.fn(async () => {
        await gate
        return { outcome, reason: 'write_failed' as const }
      })
      const test = harness(write)
      test.send(1, 'prefix')
      test.send(2, '\r')
      release()
      await vi.waitFor(() => expect(test.receipts).toHaveLength(2))
      expect(write).toHaveBeenCalledTimes(1)
      expect(test.receipts[1]).toEqual({
        sequence: 2,
        outcome: 'rejected',
        reason: 'dependency_failed'
      })
      test.send(3, 'more')
      expect(test.receipts[2]).toMatchObject({ sequence: 3, reason: 'dependency_failed' })
    }
  )

  it('allows earlier writes to finish after overflow but rejects its entire suffix', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = vi.fn(async () => {
      await gate
      return { outcome: 'accepted' as const }
    })
    const test = harness(write, { maxFrameBytes: 8, maxPendingBytes: 8, maxPendingFrames: 1 })
    test.send(1, 'first')
    test.send(2, 'next')
    test.send(3, '\r')
    expect(test.receipts).toEqual([
      { sequence: 2, outcome: 'rejected', reason: 'queue_full' },
      { sequence: 3, outcome: 'rejected', reason: 'dependency_failed' }
    ])
    release()
    await vi.waitFor(() => expect(test.receipts).toHaveLength(3))
    expect(test.receipts[2]).toEqual({ sequence: 1, outcome: 'accepted' })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('counts UTF-8 bytes and rejects oversized frames before scheduling', () => {
    const write = vi.fn(async () => ({ outcome: 'accepted' as const }))
    const test = harness(write, { maxFrameBytes: 3, maxPendingBytes: 8, maxPendingFrames: 2 })
    test.send(1, '🙂')
    expect(test.receipts).toEqual([{ sequence: 1, outcome: 'rejected', reason: 'too_large' }])
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects malformed UTF-8 instead of silently changing terminal bytes', () => {
    const write = vi.fn(async () => ({ outcome: 'accepted' as const }))
    const test = harness(write)
    test.stream.receive(1, new Uint8Array([0xff]))
    expect(test.receipts).toEqual([{ sequence: 1, outcome: 'rejected', reason: 'invalid_payload' }])
    expect(write).not.toHaveBeenCalled()
  })

  it.each([0, 2, Number.MAX_SAFE_INTEGER + 1])(
    'closes on invalid sequence %s without writing',
    (seq) => {
      const write = vi.fn(async () => ({ outcome: 'accepted' as const }))
      const test = harness(write)
      test.send(seq, 'bad')
      test.send(1, 'late')
      expect(write).not.toHaveBeenCalled()
      expect(test.receipts).toEqual([
        { sequence: seq, outcome: 'rejected', reason: 'invalid_sequence' }
      ])
    }
  )

  it('does not replay duplicate sequences', async () => {
    const write = vi.fn(async () => ({ outcome: 'accepted' as const }))
    const test = harness(write)
    test.send(1, 'once')
    await vi.waitFor(() => expect(test.receipts).toHaveLength(1))
    test.send(1, 'once')
    expect(write).toHaveBeenCalledTimes(1)
    expect(test.receipts[1].reason).toBe('invalid_sequence')
  })

  it('drops queued input and late receipts after detach', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = vi.fn(async () => {
      await gate
      return { outcome: 'accepted' as const }
    })
    const test = harness(write)
    test.send(1, 'in flight')
    test.send(2, 'queued')
    test.close()
    release()
    await new Promise((resolve) => setImmediate(resolve))
    expect(write).toHaveBeenCalledTimes(1)
    expect(test.receipts).toEqual([])
  })
})
