import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BINARY_PROBE_BYTES,
  MAX_TEXT_FILE_SIZE,
  readLocalFileContent,
  readLocalLogSnapshot
} from './filesystem-file-content-inspection'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-binary-budget-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function sizedFile(name: string, size: number, nullOffset?: number): Promise<string> {
  const filePath = join(root, name)
  const prefix = Buffer.alloc(Math.max(BINARY_PROBE_BYTES, (nullOffset ?? 0) + 1), 0x61)
  if (nullOffset !== undefined) {
    prefix[nullOffset] = 0
  }
  const handle = await open(filePath, 'w')
  try {
    await handle.write(prefix)
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
  return filePath
}

describe('local binary classification before text read budget', () => {
  it.each([
    ['archive.zip', 0],
    ['archive.bin', BINARY_PROBE_BYTES - 1],
    ['misnamed.JSON', 7]
  ] as const)('returns only a binary placeholder for oversized %s', async (name, nullOffset) => {
    const filePath = await sizedFile(name, MAX_TEXT_FILE_SIZE + 1, nullOffset)
    await expect(readLocalFileContent(filePath)).resolves.toEqual({ content: '', isBinary: true })
  })

  it('still refuses an oversized unknown file with a text-like prefix', async () => {
    const filePath = await sizedFile('large.txt', MAX_TEXT_FILE_SIZE + 1)
    await expect(readLocalFileContent(filePath)).rejects.toThrow('exceeds 50MB limit')
  })

  it.each(['large.PNG', 'large.PDF'])('keeps the preview budget for %s', async (name) => {
    const filePath = await sizedFile(name, MAX_TEXT_FILE_SIZE + 1, 0)
    await expect(readLocalFileContent(filePath)).rejects.toThrow('exceeds 50MB limit')
  })

  it('ignores NUL just outside the binary probe and preserves text refusal', async () => {
    const filePath = await sizedFile(
      'outside-probe.bin',
      MAX_TEXT_FILE_SIZE + 1,
      BINARY_PROBE_BYTES
    )
    await expect(readLocalFileContent(filePath)).rejects.toThrow('exceeds 50MB limit')
  })

  it.each([1, BINARY_PROBE_BYTES])(
    'classifies a %i-byte binary at the probe boundary',
    async (size) => {
      const filePath = await sizedFile('boundary.bin', size, size - 1)
      await expect(readLocalFileContent(filePath)).resolves.toEqual({ content: '', isBinary: true })
    }
  )

  it('preserves an empty text file', async () => {
    const filePath = await sizedFile('empty.bin', 0)
    await expect(readLocalFileContent(filePath)).resolves.toEqual({ content: '', isBinary: false })
  })

  it('keeps the opt-in log snapshot budget before reading content', async () => {
    const filePath = await sizedFile('large.jsonl', MAX_TEXT_FILE_SIZE + 1, 0)
    await expect(readLocalLogSnapshot(filePath)).rejects.toThrow('exceeds 50MB limit')
  })

  it('preserves small binary, text and preview payloads', async () => {
    const binary = join(root, 'small.bin')
    const text = join(root, 'small.txt')
    const image = join(root, 'small.png')
    const bytes = Buffer.from([1, 0, 2])
    await writeFile(binary, bytes)
    await writeFile(text, 'Owned text.\n')
    await writeFile(image, bytes)
    await expect(readLocalFileContent(binary)).resolves.toEqual({ content: '', isBinary: true })
    await expect(readLocalFileContent(text)).resolves.toEqual({
      content: 'Owned text.\n',
      isBinary: false
    })
    await expect(readLocalFileContent(image)).resolves.toEqual({
      content: bytes.toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })
  })
})
