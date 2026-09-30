import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readMacClipboardImageFileAsPng } from './clipboard-mac-image-file'

function pngHeader(width = 640, height = 400): Buffer {
  const source = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(source)
  source.writeUInt32BE(13, 8)
  source.write('IHDR', 12, 'ascii')
  source.writeUInt32BE(width, 16)
  source.writeUInt32BE(height, 20)
  return source
}

function filenamesPlist(paths: string[]): string {
  return `<plist version="1.0"><array>${paths.map((p) => `<string>${p}</string>`).join('')}</array></plist>`
}

describe('readMacClipboardImageFileAsPng', () => {
  let dir: string
  let screenshotPath: string
  const png = Buffer.from([9, 8, 7])
  const createImageFromBuffer = vi.fn(() => ({
    getSize: () => ({ height: 400, width: 640 }),
    isEmpty: () => false,
    toPNG: () => png
  }))
  const deps = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader only calls getSize/isEmpty/toPNG, all stubbed above.
    createImageFromBuffer: createImageFromBuffer as never,
    openFile: (filePath: string) => open(filePath, 'r')
  }

  beforeEach(async () => {
    createImageFromBuffer.mockClear()
    dir = await mkdtemp(join(tmpdir(), 'orca-mac-clip-'))
    screenshotPath = join(dir, 'Screenshot 2026-09-28 at 09.30.00.png')
    await writeFile(screenshotPath, pngHeader())
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the image file behind a Finder Cmd+C (file URL + filename text)', async () => {
    await expect(
      readMacClipboardImageFileAsPng(
        {
          fileUrl: pathToFileURL(screenshotPath).href,
          filenamesPlist: filenamesPlist([screenshotPath]),
          text: 'Screenshot 2026-09-28 at 09.30.00.png'
        },
        deps
      )
    ).resolves.toBe(png)
    expect(createImageFromBuffer).toHaveBeenCalledWith(pngHeader())
  })

  it('accepts a file URL with no text or with the full path as text', async () => {
    for (const text of ['', screenshotPath]) {
      await expect(
        readMacClipboardImageFileAsPng(
          { fileUrl: pathToFileURL(screenshotPath).href, filenamesPlist: '', text },
          deps
        )
      ).resolves.toBe(png)
    }
  })

  it('accepts the extension-hidden Finder display name as text', async () => {
    await expect(
      readMacClipboardImageFileAsPng(
        {
          fileUrl: pathToFileURL(screenshotPath).href,
          filenamesPlist: '',
          text: 'Screenshot 2026-09-28 at 09.30.00'
        },
        deps
      )
    ).resolves.toBe(png)
  })

  it('matches an NFD file URL against NFC filename text', async () => {
    const nfcName = 'Capture d\u2019\u00e9cran 2026-09-28 \u00e0 09.30.00.png'
    const nfdPath = join(dir, nfcName.normalize('NFD'))
    await writeFile(nfdPath, pngHeader())
    for (const text of [nfcName, nfcName.replace(/\.png$/, '')]) {
      await expect(
        readMacClipboardImageFileAsPng(
          { fileUrl: pathToFileURL(nfdPath).href, filenamesPlist: '', text },
          deps
        )
      ).resolves.toBe(png)
    }
  })

  it.each([
    ['unrelated text', { text: 'look at this' }],
    ['a multi-file selection', { multi: true }],
    ['a non-image file', { file: 'notes.txt' }],
    ['a non-file URL', { fileUrl: 'https://example.com/a.png' }],
    ['no file URL', { fileUrl: '' }]
  ])('ignores %s', async (_label, variant: Record<string, unknown>) => {
    const filePath = typeof variant.file === 'string' ? join(dir, variant.file) : screenshotPath
    await writeFile(join(dir, 'notes.txt'), pngHeader())
    const fileUrl =
      typeof variant.fileUrl === 'string' ? variant.fileUrl : pathToFileURL(filePath).href
    await expect(
      readMacClipboardImageFileAsPng(
        {
          fileUrl,
          filenamesPlist: filenamesPlist(
            variant.multi ? [filePath, join(dir, 'b.png')] : [filePath]
          ),
          text: typeof variant.text === 'string' ? variant.text : ''
        },
        deps
      )
    ).resolves.toBeNull()
    expect(createImageFromBuffer).not.toHaveBeenCalled()
  })

  it('ignores a copied image file that no longer exists', async () => {
    await expect(
      readMacClipboardImageFileAsPng(
        {
          fileUrl: pathToFileURL(join(dir, 'gone.png')).href,
          filenamesPlist: '',
          text: 'gone.png'
        },
        deps
      )
    ).resolves.toBeNull()
  })
})
