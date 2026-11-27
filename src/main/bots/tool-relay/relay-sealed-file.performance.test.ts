// Guards #51086: a burst of kept-entry changes costs at most one write in flight plus one queued,
// whatever its size, never a whole-file write per change.
import { describe, expect, it } from 'vitest'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import { RelaySealedFile } from './relay-sealed-file'

const isNumber = (value: unknown): value is number => typeof value === 'number'

async function burst(changes: number): Promise<{ publishes: number; serialized: number }> {
  let publishes = 0
  let serialized = 0
  const entries: number[] = []
  const file = new RelaySealedFile<number>('/unused', isNumber, async (_path, payload) => {
    publishes += 1
    const written = jsonProperty(JSON.parse(payload), 'entries')
    serialized += Array.isArray(written) ? written.length : 0
    await new Promise((resolve) => setImmediate(resolve))
  })
  const writes: Promise<void>[] = []
  for (let index = 0; index < changes; index += 1) {
    entries.push(index)
    writes.push(file.write(() => entries))
  }
  await Promise.all(writes)
  return { publishes, serialized }
}

describe('kept relay file writes', () => {
  it('coalesces a burst of N changes into at most two writes, at N and 10N', async () => {
    for (const changes of [100, 1_000]) {
      const { publishes, serialized } = await burst(changes)
      expect(publishes).toBeLessThanOrEqual(2)
      // Each write holds the whole state once: never N(N+1)/2 records.
      expect(serialized).toBeLessThanOrEqual(1 + changes)
    }
  })
})
