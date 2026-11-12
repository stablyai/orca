import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as durable from '../../filesystem/durable-file-write'
import { writeUsageSourceCache } from './usage-source-cache-file'

it('bounds source-cache write batches as one source grows from N to 10N events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-usage-stream-contract-'))
  const receipts: { bytes: number; maximum: number; chunks: number }[] = []
  const write = vi
    .spyOn(durable, 'writeFileDurable')
    .mockImplementation(async (_tmp, _final, data) => {
      const receipt = { bytes: 0, maximum: 0, chunks: 0 }
      const chunks = typeof data === 'string' || data instanceof Uint8Array ? [data] : data
      for await (const chunk of chunks) {
        const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
        receipt.bytes += bytes
        receipt.maximum = Math.max(receipt.maximum, bytes)
        receipt.chunks++
      }
      receipts.push(receipt)
    })
  try {
    for (const events of [10_000, 100_000]) {
      await writeUsageSourceCache(
        {
          path: join(directory, 'sources.json'),
          schemaVersion: 7,
          worktreeFingerprint: null,
          reuse: true
        },
        [
          {
            ownedEventKeys: Array.from(
              { length: events },
              (_, index) => `turn-${index}|100000,50000,1000,0,101000|1000,500,10,0,1010`
            )
          }
        ]
      )
    }
    for (const receipt of receipts) {
      // Output-sized work, with bounded batches and no awaited write per event.
      expect(receipt.maximum).toBeLessThanOrEqual(256 * 1024)
      expect(receipt.chunks).toBeLessThanOrEqual(Math.ceil(receipt.bytes / (32 * 1024)) + 1)
    }
    expect(receipts[1].bytes).toBeGreaterThan(receipts[0].bytes * 9)
    expect(receipts[1].chunks).toBeLessThanOrEqual(receipts[0].chunks * 11)
  } finally {
    write.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
