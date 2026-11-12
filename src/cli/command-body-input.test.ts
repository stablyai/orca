import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readTextOrFileFlag } from './command-body-input'

afterEach(() => vi.restoreAllMocks())

it('refuses an oversized file at the byte boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-bounded-body-'))
  try {
    await writeFile(join(directory, 'body.txt'), 'éééé')
    await expect(
      readTextOrFileFlag(new Map([['body-file', 'body.txt']]), directory, 'body', true, 6)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('refuses overflowing stdin without waiting for the remaining input', async () => {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
    yield Buffer.from('éé')
    yield Buffer.from('éé')
    throw new Error('Input continued beyond the byte limit.')
  })
  await expect(
    readTextOrFileFlag(new Map([['body-file', '-']]), tmpdir(), 'body', true, 6)
  ).rejects.toMatchObject({ code: 'invalid_argument' })
})
