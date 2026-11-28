import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeZcodeInstructions } from './zcode-structured-instructions'

// The invariant: a chat never starts on rules ZCode would not read in full. ZCode cuts a folder's
// AGENTS.md at 100 KB without a word, and reads a linked one wherever it points.
const RULES_AT_THE_END = 'Never post anywhere unless your owner asked for it in this chat.'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zcode-instructions-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ZCode instructions', () => {
  it('refuses a file ZCode would cut off, rather than start without the end of the rules', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'x'.repeat(100 * 1024))
    await expect(writeZcodeInstructions(dir, RULES_AT_THE_END)).rejects.toThrow(
      /did not start without them/
    )
  })

  it('takes a file ZCode reads in full', async () => {
    await writeZcodeInstructions(dir, RULES_AT_THE_END)
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain(RULES_AT_THE_END)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a linked AGENTS.md, which ZCode reads wherever it points',
    async () => {
      const elsewhere = join(dir, 'elsewhere.md')
      await writeFile(elsewhere, "Someone else's rules.\n")
      await symlink(elsewhere, join(dir, 'AGENTS.md'))
      await expect(writeZcodeInstructions(dir, RULES_AT_THE_END)).rejects.toThrow(
        /did not start without them/
      )
      expect(await readFile(elsewhere, 'utf8')).toBe("Someone else's rules.\n")
    }
  )
})
