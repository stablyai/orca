import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readLocalFileRange } from './local-file-range-read'

let folder: string
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'orca-file-range-'))
})
afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

it('reads only the requested bytes and reports partial and past-EOF ranges', async () => {
  const file = join(folder, 'records.csv')
  await writeFile(file, '0123456789')
  await expect(readLocalFileRange(file, 3, 4)).resolves.toEqual({
    contentBase64: Buffer.from('3456').toString('base64'),
    bytesRead: 4,
    eof: false
  })
  await expect(readLocalFileRange(file, 8, 4)).resolves.toEqual({
    contentBase64: Buffer.from('89').toString('base64'),
    bytesRead: 2,
    eof: true
  })
  await expect(readLocalFileRange(file, 12, 4)).resolves.toEqual({
    contentBase64: '',
    bytesRead: 0,
    eof: true
  })
})

it('refuses directories through the shared regular-file guard', async () => {
  await expect(readLocalFileRange(folder, 0, 4)).rejects.toThrow()
})

it('rejects invalid or excessive ranges before opening the path', async () => {
  for (const [offset, length] of [
    [-1, 1],
    [0, 0],
    [0, 512 * 1024 + 1],
    [Number.MAX_SAFE_INTEGER, 2]
  ]) {
    await expect(readLocalFileRange(join(folder, 'missing.csv'), offset, length)).rejects.toThrow(
      'Invalid file read range'
    )
  }
})
