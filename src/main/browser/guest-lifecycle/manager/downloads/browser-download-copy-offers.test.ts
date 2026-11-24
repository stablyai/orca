import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BROWSER_DOWNLOAD_COPY_FRAME_KIND,
  BROWSER_DOWNLOAD_COPY_WINDOW_BYTES,
  encodeBrowserDownloadCopyAck
} from '../../../../../shared/browser/downloads/browser-download-copy-stream'
import {
  claimBrowserDownloadCopy,
  offerBrowserDownloadCopy,
  releaseBrowserDownloadCopy
} from './browser-download-copy-offers'
import { streamBrowserDownloadCopy } from './browser-download-copy-stream'

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
  it('streams the saved file once, only to the offered device, never more than a window ahead', async () => {
    const bytes = Buffer.alloc(5 * BROWSER_DOWNLOAD_COPY_WINDOW_BYTES + 3)
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 31) % 251
    }
    const { savePath } = await savedFile(bytes)
    const copyId = (await offerBrowserDownloadCopy('desk-a', savePath))!

    await expect(claimBrowserDownloadCopy('desk-b', copyId)).rejects.toThrow()
    await expect(claimBrowserDownloadCopy(undefined, copyId)).rejects.toThrow()
    expect(releaseBrowserDownloadCopy('desk-b', { copyId }).released).toBe(false)

    const file = await claimBrowserDownloadCopy('desk-a', copyId)
    // A replay or a second stream can't take the file again.
    await expect(claimBrowserDownloadCopy('desk-a', copyId)).rejects.toThrow()

    // The desktop: writes (copies) each frame, then acks what it has written, a turn later.
    const received: Buffer[] = []
    let written = 0
    let maxAhead = 0
    let onAck: (bytes: Uint8Array) => void = () => {}
    const events: unknown[] = []
    await streamBrowserDownloadCopy(file, {
      emit: (event) => events.push(event),
      registerBinaryMessageHandler: (handler) => {
        onAck = handler
        return () => {}
      },
      sendBinary: (frame) => {
        expect(frame[0]).toBe(BROWSER_DOWNLOAD_COPY_FRAME_KIND)
        received.push(Buffer.from(frame.subarray(1)))
        const total = received.reduce((n, b) => n + b.length, 0)
        maxAhead = Math.max(maxAhead, total - written)
        setImmediate(() => {
          written += frame.byteLength - 1
          onAck(encodeBrowserDownloadCopyAck(written))
        })
        return true
      }
    })
    await file.handle.close()

    expect(events).toEqual([{ type: 'start', size: bytes.length }, { type: 'end' }])
    expect(Buffer.concat(received).equals(bytes)).toBe(true)
    expect(maxAhead).toBeLessThanOrEqual(BROWSER_DOWNLOAD_COPY_WINDOW_BYTES)
  })

  it('stops on an ack for bytes it never sent', async () => {
    const { savePath } = await savedFile(Buffer.alloc(3 * BROWSER_DOWNLOAD_COPY_WINDOW_BYTES))
    const file = await claimBrowserDownloadCopy(
      'desk-a',
      (await offerBrowserDownloadCopy('desk-a', savePath))!
    )
    let onAck: (bytes: Uint8Array) => void = () => {}
    await expect(
      streamBrowserDownloadCopy(file, {
        emit: () => {},
        registerBinaryMessageHandler: (handler) => {
          onAck = handler
          return () => {}
        },
        sendBinary: () => {
          setImmediate(() => onAck(encodeBrowserDownloadCopyAck(Number.MAX_SAFE_INTEGER)))
          return true
        }
      })
    ).rejects.toThrow()
    await file.handle.close()
  })

  it('refuses a file swapped in at the saved path', async () => {
    const { savePath } = await savedFile(Buffer.from('report'))
    const copyId = (await offerBrowserDownloadCopy('desk-a', savePath))!
    await rm(savePath)
    await writeFile(savePath, 'other!')
    await expect(claimBrowserDownloadCopy('desk-a', copyId)).rejects.toThrow()
  })

  // Windows needs a privilege to make links.
  it.skipIf(process.platform === 'win32')('never follows a link at the saved path', async () => {
    const { dir, savePath } = await savedFile(Buffer.from('report'))
    const secret = path.join(dir, 'secret')
    await writeFile(secret, 'secret')
    const copyId = (await offerBrowserDownloadCopy('desk-a', savePath))!
    await rm(savePath)
    await symlink(secret, savePath)
    await expect(claimBrowserDownloadCopy('desk-a', copyId)).rejects.toThrow()
    expect(await offerBrowserDownloadCopy('desk-a', savePath)).toBeNull()
  })
})
