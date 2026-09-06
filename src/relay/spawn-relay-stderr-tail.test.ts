import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnRelay } from './subprocess-test-utils'

describe('spawnRelay stderr tail', () => {
  it('keeps a multibyte character split across stderr chunks intact', async () => {
    // Child writes the two bytes of 'β' in separate chunks (30ms apart, so the
    // kernel cannot coalesce them), then exits before the READY sentinel so the
    // accumulated stderr tail is surfaced in the rejection message.
    const dir = mkdtempSync(path.join(tmpdir(), 'relay-stderr-tail-'))
    const entry = path.join(dir, 'split-stderr.js')
    writeFileSync(
      entry,
      [
        'process.stderr.write(Buffer.from([0xce]))',
        'setTimeout(() => {',
        '  process.stderr.write(Buffer.from([0xb2]))',
        '  process.exit(1)',
        '}, 30)'
      ].join('\n')
    )
    const relay = spawnRelay(entry)
    await expect(relay.sentinelReceived).rejects.toThrow('β')
    await relay.waitForExit()
  })
})
