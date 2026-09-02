import { describe, expect, it } from 'vitest'
import { getKeyedSerializedQueueTail, runKeyedSerializedOperation } from './keyed-promise-queue'

describe('runKeyedSerializedOperation', () => {
  it('propagates rejections to the caller but never through the stored tail', async () => {
    const queues = new Map<string, Promise<void>>()
    const failing = runKeyedSerializedOperation(queues, 'key', async () => {
      throw new Error('write failed')
    })
    // Why: awaiting the tail is how reads barrier on writes; an unrelated
    // failed write must not abort the reader (startup candidate discovery).
    const tail = getKeyedSerializedQueueTail(queues, 'key')

    await expect(failing).rejects.toThrow('write failed')
    await expect(tail).resolves.toBeUndefined()
    await expect(runKeyedSerializedOperation(queues, 'key', async () => 'recovered')).resolves.toBe(
      'recovered'
    )
  })

  it('serializes operations per key and clears settled queues', async () => {
    const queues = new Map<string, Promise<void>>()
    const events: string[] = []
    let release!: () => void
    const first = runKeyedSerializedOperation(queues, 'a', async () => {
      events.push('first-start')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      events.push('first-end')
    })
    const second = runKeyedSerializedOperation(queues, 'a', async () => {
      events.push('second')
    })
    const other = runKeyedSerializedOperation(queues, 'b', async () => {
      events.push('other')
    })

    await other
    expect(events).toEqual(['first-start', 'other'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first-start', 'other', 'first-end', 'second'])
    await expect(getKeyedSerializedQueueTail(queues, 'a')).resolves.toBeUndefined()
    expect(queues.size).toBe(0)
  })
})
