import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'

function makeSocket() {
  const socket = new Socket()
  const completions: (() => void)[] = []
  const writes: string[] = []
  const buffered = vi.spyOn(socket, 'writableLength', 'get').mockReturnValue(128 * 1024)
  vi.spyOn(socket, 'write').mockImplementation((...args) => {
    writes.push(String(args[0]))
    const complete = args.at(-1)
    if (typeof complete === 'function') {
      completions.push(() => complete())
    }
    return false
  })
  return { socket, completions, writes, buffered }
}

function refillOwnerCount(batcher: DaemonStreamDataBatcher): number {
  const instance: unknown = batcher
  if (typeof instance !== 'object' || instance === null) {
    throw new Error('Missing batcher instance')
  }
  const owner = 'heldRefill' in instance ? instance.heldRefill : instance
  if (typeof owner !== 'object' || owner === null) {
    throw new Error('Missing refill owner')
  }
  const entries =
    'armed' in owner
      ? owner.armed
      : 'refillArmedClients' in owner
        ? owner.refillArmedClients
        : undefined
  if (entries instanceof Map || entries instanceof Set) {
    return entries.size
  }
  throw new Error('Missing refill ownership collection')
}

describe('retired daemon stream refill owners', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('releases every disconnected client id before socket callbacks settle', () => {
    const transport = makeSocket()
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: transport.socket }))
    for (let index = 0; index < 200; index += 1) {
      const clientId = `retired-client-${index}`
      batcher.enqueue(clientId, 'session', 'x'.repeat(8192))
      batcher.flush(clientId)
      batcher.clear(clientId)
      expect(batcher.queuedCharsForClient(clientId)).toBe(0)
    }
    expect(transport.completions).toHaveLength(200)
    expect(refillOwnerCount(batcher)).toBe(0)
  })

  it('prevents a retired completion from flushing or disarming a replacement client', () => {
    const old = makeSocket()
    const replacement = makeSocket()
    let current = old
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: current.socket }))
    batcher.enqueue('client', 'session', 'old'.repeat(4096))
    batcher.flush('client')
    batcher.clear('client')
    current = replacement
    batcher.enqueue('client', 'session', 'new'.repeat(4096))
    batcher.flush('client')
    const flush = vi.spyOn(batcher, 'flush')
    old.completions[0]()
    expect(flush).not.toHaveBeenCalled()
    expect(replacement.completions).toHaveLength(1)
    expect(refillOwnerCount(batcher)).toBe(1)
    replacement.buffered.mockReturnValue(0)
    replacement.completions[0]()
    expect(flush).toHaveBeenCalledOnce()
    expect(batcher.queuedCharsForClient('client')).toBe(0)
    expect(refillOwnerCount(batcher)).toBe(0)
  })

  it('preserves complete live output and releases its owner when writes drain', () => {
    const transport = makeSocket()
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: transport.socket }))
    const output = 'ordinary-live-output\n'.repeat(1024)
    batcher.enqueue('client', 'session', output)
    batcher.flush('client')
    expect(batcher.queuedCharsForClient('client')).toBe(output.length)
    transport.buffered.mockReturnValue(0)
    transport.completions[0]()
    const delivered = transport.writes
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'data')
      .map((event) => event.payload.data)
      .join('')
    expect(delivered).toBe(output)
    expect(batcher.queuedCharsForClient('client')).toBe(0)
    expect(refillOwnerCount(batcher)).toBe(0)
  })

  it('clears all owner metadata and ignores all late completions at shutdown', () => {
    const transport = makeSocket()
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: transport.socket }))
    for (const client of ['one', 'two']) {
      batcher.enqueue(client, 'session', 'x'.repeat(8192))
      batcher.flush(client)
    }
    batcher.clear()
    const flush = vi.spyOn(batcher, 'flush')
    for (const complete of transport.completions) {
      complete()
    }
    expect(flush).not.toHaveBeenCalled()
    expect(refillOwnerCount(batcher)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
