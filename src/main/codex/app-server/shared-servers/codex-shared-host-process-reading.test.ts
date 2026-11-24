import { describe, expect, it } from 'vitest'
import { coalescedReading } from './codex-shared-host-process-reading'

describe('coalesced host process reading', () => {
  it('serves concurrent requests with one reading, and a request made during it with a later one', async () => {
    let reads = 0
    let finish = (): void => {}
    const read = coalescedReading(async () => {
      reads += 1
      const n = reads
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return n
    })
    const first = Array.from({ length: 100 }, () => read())
    await new Promise((resolve) => setImmediate(resolve))
    expect(reads).toBe(1)
    // Asked after the first reading began, so it must not get that table.
    const late = [read(), read()]
    finish()
    expect(await Promise.all(first)).toEqual(Array(100).fill(1))
    await new Promise((resolve) => setImmediate(resolve))
    expect(reads).toBe(2)
    finish()
    expect(await Promise.all(late)).toEqual([2, 2])
  })
})
