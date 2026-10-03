import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readBodyFlags, type BodyFlagLimit } from './body-flag-input'
import { RuntimeClientError } from './runtime-client'

const LIMIT: BodyFlagLimit = {
  maxChars: 10,
  tooLarge: () => new RuntimeClientError('body_too_large', 'too large')
}

function flagsOf(entries: Record<string, string>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

describe('readBodyFlags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-body-flags-'))

  it('reads --body and relative --body-file within the cap', async () => {
    writeFileSync(join(dir, 'note.md'), 'hello')
    await expect(
      readBodyFlags(flagsOf({ body: 'hi' }), dir, { required: true, limit: LIMIT })
    ).resolves.toBe('hi')
    await expect(
      readBodyFlags(flagsOf({ 'body-file': 'note.md' }), dir, { required: true, limit: LIMIT })
    ).resolves.toBe('hello')
  })

  it('refuses a file larger than the cap could ever decode to, before reading it', async () => {
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(LIMIT.maxChars * 4 + 1))
    await expect(
      readBodyFlags(flagsOf({ 'body-file': 'big.md' }), dir, { required: true, limit: LIMIT })
    ).rejects.toThrow('too large')
  })

  it('refuses text over the character cap and conflicting flags', async () => {
    await expect(
      readBodyFlags(flagsOf({ body: 'x'.repeat(11) }), dir, { required: true, limit: LIMIT })
    ).rejects.toThrow('too large')
    await expect(
      readBodyFlags(flagsOf({ body: 'a', 'body-file': 'note.md' }), dir, {
        required: true,
        limit: LIMIT
      })
    ).rejects.toThrow(/either --body or --body-file/)
    await expect(
      readBodyFlags(new Map(), dir, { required: false, limit: LIMIT })
    ).resolves.toBeUndefined()
  })
})
