import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  offerBrowserDownloadCopy,
  readBrowserDownloadCopy,
  releaseBrowserDownloadCopy
} from './browser-download-copy-offers'

const dirs: string[] = []

async function savedFile(bytes: Buffer): Promise<{ dir: string; savePath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'download-copy-'))
  dirs.push(dir)
  const savePath = path.join(dir, 'q3-report.pdf')
  await writeFile(savePath, bytes)
  return { dir, savePath }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('browser download copy offers', () => {
  it('hands the saved file only to the offered device, once, in order', async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 3)
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 31) % 251
    }
    const { savePath } = await savedFile(bytes)
    const copyId = (await offerBrowserDownloadCopy('desk-a', savePath))!

    await expect(readBrowserDownloadCopy('desk-b', { copyId, offset: 0 })).rejects.toThrow()
    await expect(readBrowserDownloadCopy(undefined, { copyId, offset: 0 })).rejects.toThrow()
    expect(releaseBrowserDownloadCopy('desk-b', { copyId }).released).toBe(false)

    const slices: Buffer[] = []
    let offset = 0
    for (;;) {
      const read = await readBrowserDownloadCopy('desk-a', { copyId, offset })
      slices.push(Buffer.from(read.contentBase64, 'base64'))
      offset += read.bytesRead
      if (read.eof) {
        break
      }
      // A replayed slice can't take the file a second time.
      await expect(readBrowserDownloadCopy('desk-a', { copyId, offset: 0 })).rejects.toThrow()
    }
    expect(slices.length).toBeGreaterThan(1)
    expect(Buffer.concat(slices).equals(bytes)).toBe(true)
    // The last slice ends the offer.
    await expect(readBrowserDownloadCopy('desk-a', { copyId, offset: 0 })).rejects.toThrow()
  })

  it('refuses a file swapped in at the saved path', async () => {
    const { savePath } = await savedFile(Buffer.from('report'))
    const copyId = (await offerBrowserDownloadCopy('desk-a', savePath))!
    await rm(savePath)
    await writeFile(savePath, 'other!')
    await expect(readBrowserDownloadCopy('desk-a', { copyId, offset: 0 })).rejects.toThrow()
  })

  // Windows needs a privilege to make links.
  it.skipIf(process.platform === 'win32')('never follows a link at the saved path', async () => {
    const { dir, savePath } = await savedFile(Buffer.from('report'))
    const secret = path.join(dir, 'secret')
    await writeFile(secret, 'secret')
    const copyId = (await offerBrowserDownloadCopy('desk-a', savePath))!
    await rm(savePath)
    await symlink(secret, savePath)
    await expect(readBrowserDownloadCopy('desk-a', { copyId, offset: 0 })).rejects.toThrow()
    expect(await offerBrowserDownloadCopy('desk-a', savePath)).toBeNull()
  })
})
