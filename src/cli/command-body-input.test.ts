import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCommandBody } from './command-body-input'

const OPTIONS = {
  maximumCharacters: 10,
  tooLargeCode: 'body_too_large',
  label: 'Body'
}

function flagsOf(entries: Record<string, string>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

describe('readCommandBody', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-body-flags-'))

  it('reads --body and relative --body-file within the cap', async () => {
    writeFileSync(join(dir, 'note.md'), 'hello')
    await expect(
      readCommandBody(flagsOf({ body: 'hi' }), dir, { ...OPTIONS, required: true })
    ).resolves.toBe('hi')
    await expect(
      readCommandBody(flagsOf({ 'body-file': 'note.md' }), dir, { ...OPTIONS, required: true })
    ).resolves.toBe('hello')
  })

  it('refuses a file larger than the cap could ever decode to, before reading it', async () => {
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(OPTIONS.maximumCharacters * 4 + 1))
    await expect(
      readCommandBody(flagsOf({ 'body-file': 'big.md' }), dir, { ...OPTIONS, required: true })
    ).rejects.toThrow('Body must be at most 10 characters')
  })

  it('refuses text over the character cap and conflicting flags', async () => {
    await expect(
      readCommandBody(flagsOf({ body: 'x'.repeat(11) }), dir, { ...OPTIONS, required: true })
    ).rejects.toThrow('Body must be at most 10 characters')
    await expect(
      readCommandBody(flagsOf({ body: 'a', 'body-file': 'note.md' }), dir, {
        ...OPTIONS,
        required: true
      })
    ).rejects.toThrow(/either --body or --body-file/)
    await expect(
      readCommandBody(new Map(), dir, { ...OPTIONS, required: false })
    ).resolves.toBeUndefined()
  })
})
