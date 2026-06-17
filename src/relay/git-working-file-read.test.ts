import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkingDiffFile } from './git-working-file-read'

describe('readWorkingDiffFile', () => {
  let tmpDir: string | null = null

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true })
    }
    tmpDir = null
  })

  it('reads normal text working-tree files', async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'relay-working-file-'))
    const filePath = path.join(tmpDir, 'file.txt')
    await writeFile(filePath, 'hello')

    await expect(readWorkingDiffFile(filePath)).resolves.toEqual({
      content: 'hello',
      isBinary: false
    })
  })

  it('marks oversized working-tree files as binary before diffing', async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'relay-working-file-'))
    const filePath = path.join(tmpDir, 'large.log')
    await writeFile(filePath, Buffer.alloc(10 * 1024 * 1024 + 1, 'a'))

    await expect(readWorkingDiffFile(filePath)).resolves.toEqual({
      content: '',
      isBinary: true
    })
  })
})
