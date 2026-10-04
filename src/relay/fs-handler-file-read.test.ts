import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRelayFileContent } from './fs-handler-file-read'

describe('readRelayFileContent', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'relay-file-read-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns SyncTeX data compressed and base64, not as an image', async () => {
    const gz = gzipSync('SyncTeX Version:1\n')
    const filePath = path.join(dir, 'main.synctex.gz')
    await writeFile(filePath, gz)

    await expect(readRelayFileContent(filePath)).resolves.toEqual({
      content: gz.toString('base64'),
      isBinary: true,
      isImage: false,
      mimeType: 'application/gzip'
    })
  })

  it('still returns PDFs as image previews', async () => {
    const filePath = path.join(dir, 'main.pdf')
    await writeFile(filePath, '%PDF-1.4\n')

    await expect(readRelayFileContent(filePath)).resolves.toMatchObject({
      isBinary: true,
      isImage: true,
      mimeType: 'application/pdf'
    })
  })
})
