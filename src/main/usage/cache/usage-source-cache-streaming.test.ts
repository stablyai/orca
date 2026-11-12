import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as durable from '../../filesystem/durable-file-write'
import { readUsageSourceCache, writeUsageSourceCache } from './usage-source-cache-file'

it('bounds source-cache write batches as one source grows from N to 10N events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-usage-stream-contract-'))
  const receipts: { bytes: number; maximum: number; chunks: number }[] = []
  const originalWrite = durable.writeFileDurable
  const write = vi
    .spyOn(durable, 'writeFileDurable')
    .mockImplementation(async (tmp, final, data, mode) => {
      const receipt = { bytes: 0, maximum: 0, chunks: 0 }
      async function* chunks() {
        const iterable = typeof data === 'string' || data instanceof Uint8Array ? [data] : data
        for await (const chunk of iterable) {
          const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
          receipt.bytes += bytes
          receipt.maximum = Math.max(receipt.maximum, bytes)
          receipt.chunks++
          yield chunk
        }
      }
      await originalWrite(tmp, final, chunks(), mode)
      receipts.push(receipt)
    })
  try {
    for (const events of [10_000, 100_000]) {
      const ref = {
        path: join(directory, 'sources.json'),
        schemaVersion: 7,
        worktreeFingerprint: null,
        reuse: true
      }
      const sources = [
        {
          ownedEventKeys: Array.from(
            { length: events },
            (_, index) => `turn-${index}|100000,50000,1000,0,101000|1000,500,10,0,1010`
          )
        }
      ]
      await writeUsageSourceCache(ref, sources)
      expect(await readUsageSourceCache(ref)).toEqual(sources)
    }
    for (const receipt of receipts) {
      // Output-sized work, with bounded batches and no awaited write per event.
      expect(receipt.maximum).toBeLessThanOrEqual(256 * 1024)
      expect(receipt.chunks).toBeLessThanOrEqual(Math.ceil(receipt.bytes / (32 * 1024)) + 1)
    }
    expect(receipts).toHaveLength(2)
  } finally {
    write.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
