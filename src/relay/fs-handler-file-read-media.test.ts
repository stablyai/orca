import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readRelayFileContent } from './fs-handler-file-read'

describe('readRelayFileContent media handling', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-media-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // Why: old clients read media over this path in one JSON frame; advertising
  // multi-MB base64 media here could blow their frame budget.
  it('keeps media files as plain binary markers on the legacy single-frame path', async () => {
    const filePath = path.join(tmpDir, 'clip.webm')
    const content = Buffer.alloc(64 * 1024, 0x42)
    content[0] = 0x00
    writeFileSync(filePath, content)

    const result = await readRelayFileContent(filePath)
    expect(result).toEqual({ content: '', isBinary: true })
  })

  it('still returns base64 image previews on the legacy path', async () => {
    const filePath = path.join(tmpDir, 'pixel.png')
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])
    writeFileSync(filePath, content)

    const result = await readRelayFileContent(filePath)
    expect(result).toEqual({
      content: content.toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })
  })
})
