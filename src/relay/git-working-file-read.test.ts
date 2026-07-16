import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
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

  it('returns base64 content for previewable image working-tree files', async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'relay-working-file-'))
    const filePath = path.join(tmpDir, 'image.png')
    // Why: PNG signature + trailing null byte forces the binary-detection heuristic to trip.
    const pngBuffer = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00])
    ])
    await writeFile(filePath, pngBuffer)

    await expect(readWorkingDiffFile(filePath)).resolves.toEqual({
      content: pngBuffer.toString('base64'),
      isBinary: true
    })
  })

  it('returns empty content for non-previewable binary working-tree files', async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'relay-working-file-'))
    const filePath = path.join(tmpDir, 'archive.bin')
    await writeFile(filePath, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]))

    await expect(readWorkingDiffFile(filePath)).resolves.toEqual({
      content: '',
      isBinary: true
    })
  })
})
