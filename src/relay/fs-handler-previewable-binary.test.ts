import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readRelayFileContent } from './fs-handler-file-read'
import { SPREADSHEET_FILE_MIME_TYPES } from '../shared/spreadsheet-file-extensions'

// Why: SSH worktrees read files through the relay, so a viewer that only works
// on the local read path would leave remote users with a binary placeholder.
describe('readRelayFileContent previewable binaries', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-relay-preview-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each(['xlsx', 'xlsm'])('returns base64 workbook bytes for a .%s file', async (extension) => {
    const filePath = path.join(tmpDir, `book.${extension}`)
    const workbookBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
    writeFileSync(filePath, workbookBytes)

    const result = await readRelayFileContent(filePath)

    expect(result.isBinary).toBe(true)
    expect(result.mimeType).toBe(SPREADSHEET_FILE_MIME_TYPES[`.${extension}`])
    expect(Buffer.from(result.content, 'base64')).toEqual(workbookBytes)
  })

  it('still returns base64 for images and text for text files', async () => {
    const imagePath = path.join(tmpDir, 'icon.png')
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const textPath = path.join(tmpDir, 'notes.txt')
    writeFileSync(textPath, 'hello')

    await expect(readRelayFileContent(imagePath)).resolves.toMatchObject({
      isBinary: true,
      mimeType: 'image/png'
    })
    await expect(readRelayFileContent(textPath)).resolves.toEqual({
      content: 'hello',
      isBinary: false
    })
  })

  it('does not claim the legacy .xls format it cannot parse', async () => {
    const filePath = path.join(tmpDir, 'legacy.xls')
    writeFileSync(filePath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00]))

    const result = await readRelayFileContent(filePath)

    expect(result.mimeType).toBeUndefined()
    expect(result).toMatchObject({ content: '', isBinary: true })
  })
})
