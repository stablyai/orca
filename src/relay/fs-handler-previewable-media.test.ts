import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readRelayFileContent } from './fs-handler-file-read'

describe('relay previewable media reads', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-media-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns base64 plus a video flag for playable containers', async () => {
    const filePath = path.join(tmpDir, 'clip.mp4')
    writeFileSync(filePath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66]))

    await expect(readRelayFileContent(filePath)).resolves.toEqual({
      content: 'AAAAGGY=',
      isBinary: true,
      isVideo: true,
      mimeType: 'video/mp4'
    })
  })

  it('keeps images on the image flag', async () => {
    const filePath = path.join(tmpDir, 'logo.png')
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    await expect(readRelayFileContent(filePath)).resolves.toMatchObject({
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })
  })

  it('leaves containers mobile cannot decode on the binary path', async () => {
    const filePath = path.join(tmpDir, 'clip.webm')
    writeFileSync(filePath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]))

    await expect(readRelayFileContent(filePath)).resolves.toEqual({
      content: '',
      isBinary: true
    })
  })
})
