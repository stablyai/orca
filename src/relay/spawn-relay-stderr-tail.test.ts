import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnRelay } from './subprocess-test-utils'

describe('spawnRelay stderr tail', () => {
  it('keeps a multibyte character split across stderr chunks intact', async () => {
    // Child writes the two bytes of 'β' in separate writes (the second is gated on
    // the first being flushed, so the kernel cannot coalesce them), then exits
    // before the READY sentinel so the accumulated stderr tail is surfaced in the
    // rejection message.
    const dir = mkdtempSync(path.join(tmpdir(), 'relay-stderr-tail-'))
    const entry = path.join(dir, 'split-stderr.js')
    writeFileSync(
      entry,
      [
        'const flushed = new Promise((resolve) => process.stderr.write(Buffer.from([0xce]), resolve))',
        'flushed.then(() => {',
        '  process.stderr.write(Buffer.from([0xb2]), () => process.exit(1))',
        '})'
      ].join('\n')
    )
    const relay = spawnRelay(entry)
    await expect(relay.sentinelReceived).rejects.toThrow('β')
    await relay.waitForExit()
  })

  it('preserves stderr written just before exit by rejecting only after close', async () => {
    // 'exit' can fire while stderr is still open; the tail must include the final
    // line even when the child exits immediately after writing it.
    const dir = mkdtempSync(path.join(tmpdir(), 'relay-stderr-tail-'))
    const entry = path.join(dir, 'last-line-stderr.js')
    writeFileSync(entry, 'process.stderr.write("final-diagnostic\\n", () => process.exit(1))')
    const relay = spawnRelay(entry)
    await expect(relay.sentinelReceived).rejects.toThrow('final-diagnostic')
    await relay.waitForExit()
  })
})
