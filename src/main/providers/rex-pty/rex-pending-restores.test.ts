import { describe, expect, it, vi } from 'vitest'
import { RexPendingRestores } from './rex-pending-restores'

const pending = { tail: Buffer.alloc(0), continuation: Buffer.alloc(0), nonce: 42n }

describe('Rex pending restore ownership', () => {
  it('releases a waiting attach only after activation, not discarded state', async () => {
    const restores = new RexPendingRestores()
    restores.set('a', pending, () => {})
    restores.set('b', pending, () => {})
    const a = restores.wait('a')
    const b = restores.wait('b')
    restores.delete('a', true)
    await expect(a).resolves.toBe(true)
    expect(restores.has('b')).toBe(true)
    restores.delete('b')
    await expect(b).resolves.toBe(false)
  })

  it('does not turn an expired or cancelled wait into permission to activate', async () => {
    vi.useFakeTimers()
    try {
      const restores = new RexPendingRestores(100)
      restores.set('a', pending, () => {})
      const abort = new AbortController()
      const cancelled = expect(restores.wait('a', abort.signal)).rejects.toThrow('cancelled')
      abort.abort(new Error('cancelled'))
      await cancelled
      expect(restores.has('a')).toBe(true)
      const expired = restores.wait('a')
      await vi.advanceTimersByTimeAsync(100)
      await expect(expired).resolves.toBe(false)
      expect(restores.has('a')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes captures through activation and refuses a third overlapping request', async () => {
    const restores = new RexPendingRestores()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const captures: string[] = []
    const first = restores.serializeAttach('a', undefined, async () => {
      captures.push('first')
      entered.resolve()
      await finish.promise
      restores.set('a', pending, () => {})
      return 1
    })
    await entered.promise
    const second = restores.serializeAttach('a', undefined, async () => {
      captures.push('second')
      return 2
    })
    await expect(restores.serializeAttach('a', undefined, async () => 3)).rejects.toThrow(
      'Rex attach queue full'
    )
    finish.resolve()
    await expect(first).resolves.toBe(1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(captures).toEqual(['first'])
    restores.delete('a', true)
    await expect(second).resolves.toBe(2)
    expect(captures).toEqual(['first', 'second'])
  })
})
