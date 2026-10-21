import { PassThrough, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { AcpJsonRpcPeer } from './acp-json-rpc-peer'

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 6; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function fixture(deferred: boolean, backpressure: boolean) {
  const input = new PassThrough()
  const refs: WeakRef<object>[] = []
  const writes: string[] = []
  let callback: ((error?: Error | null) => void) | undefined
  const output = new Writable({
    highWaterMark: backpressure ? 1 : 1024 * 1024,
    write(chunk, _encoding, done) {
      writes.push(JSON.parse(chunk.toString()).method)
      if (deferred) {
        callback = done
      } else {
        done()
      }
    }
  })
  output.on('newListener', (event, listener) => {
    if (event === 'drain') {
      refs.push(new WeakRef(listener))
    }
  })
  const peer = new AcpJsonRpcPeer(input, output)
  return {
    input,
    output,
    refs,
    peer,
    writes,
    complete() {
      const done = callback
      callback = undefined
      if (!done) {
        throw new Error('Missing pending stream callback')
      }
      done()
    },
    close() {
      peer.close()
      input.destroy()
      output.destroy()
    }
  }
}

it.each([false, true])(
  'releases the completed last drain closure while the peer remains usable (backpressure=%s)',
  async (backpressure) => {
    const state = fixture(false, backpressure)
    try {
      await state.peer.notify('first', { text: 'x'.repeat(256 * 1024) })
      expect(state.output.writableLength).toBe(0)
      expect(state.output.listenerCount('drain')).toBe(0)
      await collect()
      expect(state.refs.filter((ref) => ref.deref())).toHaveLength(0)
      await state.peer.notify('next', {})
      expect(state.writes).toEqual(['first', 'next'])
    } finally {
      state.close()
    }
  }
)

it('keeps the active write until stream completion then releases its drain closure', async () => {
  const state = fixture(true, true)
  try {
    const first = state.peer.notify('first', {})
    const second = state.peer.notify('second', {})
    await collect()
    expect(state.refs.filter((ref) => ref.deref())).toHaveLength(1)
    expect(state.writes).toEqual(['first'])
    state.complete()
    await first
    expect(state.writes).toEqual(['first', 'second'])
    state.complete()
    await second
    await collect()
    expect(state.refs.filter((ref) => ref.deref())).toHaveLength(0)
    expect(state.output.listenerCount('drain')).toBe(0)
  } finally {
    state.close()
  }
})

it('retires a closed peer drain closure after its late stream completion', async () => {
  const state = fixture(true, true)
  try {
    const first = expect(state.peer.notify('first', {})).rejects.toThrow('closed')
    const second = expect(state.peer.notify('second', {})).rejects.toThrow('closed')
    state.peer.close()
    await Promise.all([first, second])
    state.complete()
    await collect()
    expect(state.refs.filter((ref) => ref.deref())).toHaveLength(0)
    expect(state.output.listenerCount('drain')).toBe(0)
    expect(state.writes).toEqual(['first'])
  } finally {
    state.close()
  }
})
