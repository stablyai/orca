import { describe, expect, it } from 'vitest'
import {
  SshMultiplexerTransportWriter,
  type MultiplexerTransportWriteResult,
  type MultiplexerWriterLane
} from './ssh-multiplexer-transport-writer'

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 6; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function harness() {
  let drain: (() => void) | undefined
  let nativeCallback: ((result: MultiplexerTransportWriteResult) => void) | undefined
  const buffers: WeakRef<Buffer>[] = []
  const receipts: WeakRef<{ index: number }>[] = []
  const writes: number[] = []
  const settlements: { index: number; outcome: string }[] = []
  const writer = new SshMultiplexerTransportWriter(
    {
      supportsWriteSettlement: true,
      write: (bytes, onSettled) => {
        expect(nativeCallback).toBeUndefined()
        nativeCallback = onSettled
        writes.push(bytes.readUInt32BE())
        return false
      },
      onDrain: (listener) => {
        drain = listener
        return () => {
          drain = undefined
        }
      },
      onData: () => {},
      onClose: () => {}
    },
    (error) => {
      throw error
    }
  )
  return {
    writer,
    buffers,
    receipts,
    writes,
    settlements,
    enqueue(index: number, lane: MultiplexerWriterLane): void {
      const data = Buffer.alloc(32)
      data.writeUInt32BE(index)
      const receipt = { index }
      buffers.push(new WeakRef(data))
      receipts.push(new WeakRef(receipt))
      expect(
        writer.enqueue(data, lane, (result) => {
          settlements.push({ index: receipt.index, outcome: result.outcome })
        })
      ).toBe(true)
    },
    drain(): void {
      if (!drain) {
        throw new Error('Missing drain listener')
      }
      drain()
    },
    complete(): void {
      const callback = nativeCallback
      nativeCallback = undefined
      if (!callback) {
        throw new Error('Missing native write')
      }
      callback({ ok: true })
    },
    duplicateCompletion(): void {
      nativeCallback?.({ ok: true })
      nativeCallback?.({ ok: false, error: new Error('Late duplicate failure') })
    }
  }
}

describe('SSH writer completed entry lifetime', () => {
  for (const lane of ['ordinary', 'control'] as const) {
    it.each(['drain', 'dispose'] as const)(
      `releases completed ${lane} entries during a rolling backlog, then %s`,
      async (release) => {
        const state = harness()
        try {
          state.enqueue(0, lane)
          state.enqueue(1, lane)
          state.enqueue(2, lane)
          state.complete()
          for (let index = 0; index < 32; index += 1) {
            state.drain()
            state.complete()
            state.enqueue(index + 3, lane)
          }
          await collect()
          expect(state.buffers.slice(0, 33).filter((ref) => ref.deref())).toHaveLength(0)
          expect(state.receipts.slice(0, 33).filter((ref) => ref.deref())).toHaveLength(0)
          expect(state.buffers.slice(33).filter((ref) => ref.deref())).toHaveLength(2)
          expect(state.receipts.slice(33).filter((ref) => ref.deref())).toHaveLength(2)
          expect(state.writes).toEqual(Array.from({ length: 33 }, (_, index) => index))
          expect(state.settlements).toEqual(
            state.writes.map((index) => ({ index, outcome: 'accepted' }))
          )

          if (release === 'drain') {
            state.drain()
            state.complete()
            state.drain()
            state.complete()
          } else {
            state.writer.dispose()
          }
          await collect()
          expect(state.buffers.filter((ref) => ref.deref())).toHaveLength(0)
          expect(state.receipts.filter((ref) => ref.deref())).toHaveLength(0)
          expect(state.settlements).toHaveLength(35)
          expect(state.settlements.slice(33).map((result) => result.outcome)).toEqual(
            release === 'drain' ? ['accepted', 'accepted'] : ['refused', 'refused']
          )
        } finally {
          state.writer.dispose()
        }
      }
    )
  }

  it('preserves in-flight callback ownership and one settlement across disposal', async () => {
    const state = harness()
    try {
      state.enqueue(0, 'ordinary')
      state.enqueue(1, 'ordinary')
      state.writer.dispose()
      await collect()
      expect(state.buffers[0]?.deref()).toBeDefined()
      expect(state.receipts[0]?.deref()).toBeDefined()
      expect(state.buffers[1]?.deref()).toBeUndefined()
      expect(state.receipts[1]?.deref()).toBeUndefined()
      expect(state.settlements).toEqual([
        { index: 1, outcome: 'refused' },
        { index: 0, outcome: 'unverifiable' }
      ])
      state.duplicateCompletion()
      state.complete()
      await collect()
      expect(state.buffers.filter((ref) => ref.deref())).toHaveLength(0)
      expect(state.receipts.filter((ref) => ref.deref())).toHaveLength(0)
      expect(state.settlements).toHaveLength(2)
    } finally {
      state.writer.dispose()
    }
  })
})
