import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const downloads = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({ app: { getPath: () => downloads.path } }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return { ...fs, link: vi.fn(fs.link), open: vi.fn(fs.open) }
})
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: vi.fn(async () => ({}))
}))
vi.mock('../../ipc/runtime-environments/requests/runtime-environment-revision-guard', () => ({
  runtimeEnvironmentRevisionFailure: () => null
}))
vi.mock('../../ipc/runtime-environments/catalog/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/registry'
}))
vi.mock('../../ipc/runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn(async () => ({ ok: true })),
  subscribeRuntimeEnvironment: vi.fn()
}))

import { link, open } from 'node:fs/promises'
import {
  BROWSER_DOWNLOAD_COPY_FRAME_BYTES,
  BROWSER_DOWNLOAD_COPY_FRAME_KIND
} from '../../../shared/browser/downloads/browser-download-copy-stream'
// The real retirement listener: re-pairing or removing the server retires its transport.
import { advanceRuntimeEnvironmentTransportGeneration } from '../../ipc/runtime-environments/connections/runtime-environment-transport-generation'
import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from '../../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import {
  cancelBrowserServerDownloadCopy,
  copyBrowserServerDownloadHere
} from './browser-server-download-copy'

const fs = await vi.importActual<typeof FsPromises>('node:fs/promises')
const CONTENT = 'copied'
const RETIRED = 'The connection to the server changed. Download it again.'

type Callbacks = Parameters<typeof subscribeRuntimeEnvironment>[5]
type StreamEvent = Parameters<Callbacks['onEvent']>[0]
const response = (result: unknown): StreamEvent => ({
  type: 'response',
  response: { id: 'stream', ok: true, result, _meta: { runtimeId: 'server' } }
})
const frame = (bytes: Buffer): StreamEvent => ({
  type: 'binary',
  bytes: Uint8Array.from([BROWSER_DOWNLOAD_COPY_FRAME_KIND, ...bytes])
})

const acks = vi.fn((_frame: Uint8Array) => true)
const server: { callbacks: Callbacks | null } = { callbacks: null }

/**
 * The server streams `parts` as frames (CONTENT by default), then `end` unless `holdEnd`. Closing
 * the stream from this side makes the transport report it closed, as a real socket does.
 */
function serverSends({
  holdEnd,
  parts = [Buffer.from(CONTENT)]
}: {
  holdEnd: boolean
  parts?: Buffer[]
}) {
  vi.mocked(subscribeRuntimeEnvironment).mockImplementation(async (...args) => {
    const callbacks = args[5]
    server.callbacks = callbacks
    setTimeout(() => {
      const size = parts.reduce((total, part) => total + part.byteLength, 0)
      callbacks.onEvent(response({ type: 'start', size }))
      for (const part of parts) {
        callbacks.onEvent(frame(part))
      }
      if (!holdEnd) {
        callbacks.onEvent(response({ type: 'end' }))
      }
    }, 0)
    return { requestId: 'stream', close: () => callbacks.onClose?.(), sendBinary: acks }
  })
}

const isStaging = (filePath: unknown): boolean => path.basename(String(filePath)).startsWith('.')

/** Wraps the staging file ('staging') or, on a volume without links, the new file in Downloads. */
function wrapWritable(
  which: 'staging' | 'new',
  // Replaces some of the handle's methods; the rest stay the real ones.
  wrap: (handle: FsPromises.FileHandle) => object
): void {
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    if (args[1] !== 'wx' || isStaging(args[0]) !== (which === 'staging')) {
      return handle
    }
    return Object.assign(handle, wrap(handle))
  })
}

/** A deferred step the test releases: `entered` resolves when the code reaches it. */
function gate() {
  let enter: () => void = () => {}
  let release: (outcome?: Error) => void = () => {}
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<Error | undefined>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    async pass(): Promise<void> {
      enter()
      const failure = await released
      if (failure) {
        throw failure
      }
    }
  }
}

const withoutHardLinks = (): void => {
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('no links'), { code: 'EPERM' }))
}
const ioError = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code })
const lostWrite = (): Error => ioError('EIO: i/o error, close', 'EIO')
const diskFull = (): Error => ioError('ENOSPC: no space left on device, write', 'ENOSPC')

const copy = (copyId: string, rendererGone = new AbortController().signal) =>
  copyBrowserServerDownloadHere(
    { environmentId: 'server', copyId, filename: 'report.pdf' },
    rendererGone
  ).then(
    // What the window receives: IPC carries a structured clone.
    (result) => structuredClone(result)
  )

/** The copy's reservations were released: with nothing on disk under the name, it is offered again. */
async function nameIsFree(): Promise<boolean> {
  await fs.rm(path.join(downloads.path, 'report.pdf'), { force: true })
  const again = await browserDownloadDestinationReservations.reserveIncoming('report.pdf')
  browserDownloadDestinationReservations.release(again.reservationKey)
  return again.filename === 'report.pdf'
}

const releasedOnServer = (): string[] =>
  vi.mocked(callRuntimeEnvironment).mock.calls.map((call) => call[2])

beforeEach(async () => {
  downloads.path = await fs.mkdtemp(path.join(tmpdir(), 'server-download-copy-'))
})

afterEach(async () => {
  vi.mocked(link).mockImplementation(fs.link)
  vi.mocked(open).mockImplementation(fs.open)
  vi.mocked(callRuntimeEnvironment).mockClear()
  acks.mockClear()
  server.callbacks = null
  await fs.rm(downloads.path, { recursive: true, force: true })
})

describe('Save to this computer for a download on a paired server', () => {
  it('Cancel after part of the file arrived stops it and leaves nothing here', async () => {
    serverSends({ holdEnd: true })
    const result = copy('copy-1')
    // A frame is on disk: it was acked.
    await vi.waitFor(() => expect(acks).toHaveBeenCalled())

    expect(cancelBrowserServerDownloadCopy('copy-1')).toBe(true)
    await expect(result).resolves.toEqual({ canceled: true })
    expect(await fs.readdir(downloads.path)).toEqual([])
    expect(releasedOnServer()).toEqual(['browser.releaseDownloadCopy'])
    expect(await nameIsFree()).toBe(true)
  })

  describe('what ends a copy whose arrived file is closing', () => {
    const heldClose = (during: () => void, closeFails = false) =>
      wrapWritable('staging', (handle) => {
        const close = handle.close.bind(handle)
        return {
          close: async () => {
            during()
            await close()
            if (closeFails) {
              throw lostWrite()
            }
          }
        }
      })

    it('Cancel alone: canceled', async () => {
      serverSends({ holdEnd: false })
      let admitted: boolean | null = null
      heldClose(() => {
        admitted ??= cancelBrowserServerDownloadCopy('copy-2')
      })

      const result = await copy('copy-2')

      expect(admitted).toBe(true)
      expect(result).toEqual({ canceled: true })
      expect(await fs.readdir(downloads.path)).toEqual([])
      expect(await nameIsFree()).toBe(true)
    })

    it('a lost write on close after Cancel was accepted: the lost write', async () => {
      serverSends({ holdEnd: false })
      let admitted: boolean | null = null
      heldClose(() => {
        admitted ??= cancelBrowserServerDownloadCopy('copy-3')
      }, true)

      await expect(copy('copy-3')).rejects.toThrow('EIO: i/o error, close')
      expect(admitted).toBe(true)
      expect(await fs.readdir(downloads.path)).toEqual([])
      expect(await nameIsFree()).toBe(true)
    })

    it('the connection retired, then Cancel: Cancel is refused and the connection error shows', async () => {
      serverSends({ holdEnd: false })
      let admitted: boolean | null = null
      heldClose(() => {
        advanceRuntimeEnvironmentTransportGeneration('server')
        admitted ??= cancelBrowserServerDownloadCopy('copy-4')
      })

      const outcome = copy('copy-4')

      await expect(outcome).rejects.toThrow(RETIRED)
      expect(admitted).toBe(false)
      expect(await fs.readdir(downloads.path)).toEqual([])
    })

    it('Cancel, then the connection retired: canceled', async () => {
      serverSends({ holdEnd: false })
      let admitted: boolean | null = null
      heldClose(() => {
        admitted ??= cancelBrowserServerDownloadCopy('copy-5')
        advanceRuntimeEnvironmentTransportGeneration('server')
      })

      const result = await copy('copy-5')

      expect(admitted).toBe(true)
      expect(result).toEqual({ canceled: true })
    })

    it('the window went away, then Cancel: Cancel is refused and it fails as the window left', async () => {
      serverSends({ holdEnd: false })
      const rendererGone = new AbortController()
      let admitted: boolean | null = null
      heldClose(() => {
        rendererGone.abort(new Error('The window closed.'))
        admitted ??= cancelBrowserServerDownloadCopy('copy-6')
      })

      await expect(copy('copy-6', rendererGone.signal)).rejects.toThrow('The window closed.')
      expect(admitted).toBe(false)
      expect(await fs.readdir(downloads.path)).toEqual([])
    })
  })

  describe('Cancel while a frame is being written to disk', () => {
    /** Holds the first staging write until released; counts every write that starts. */
    function heldWrite(options: { closeFails?: boolean; shortWrite?: boolean } = {}) {
      const write = gate()
      const writesStarted = { count: 0 }
      // The order the held write finishing and the file closing happened in.
      const order: string[] = []
      wrapWritable('staging', (handle) => {
        // Bound before the wrapper below replaces it on the handle.
        const realWrite = handle.write.bind(handle)
        const close = handle.close.bind(handle)
        return {
          // The copy writes (bytes, offset, length).
          write: async (bytes: Uint8Array, offset?: number, length?: number) => {
            writesStarted.count += 1
            if (writesStarted.count === 1) {
              try {
                await write.pass()
              } finally {
                order.push('write done')
              }
            }
            const result = await realWrite(bytes, offset, length)
            // A short write: only part of the frame landed, so the rest would be written next.
            return options.shortWrite && writesStarted.count === 1
              ? { ...result, bytesWritten: 1 }
              : result
          },
          close: async () => {
            order.push('close')
            await close()
            if (options.closeFails) {
              throw lostWrite()
            }
          }
        }
      })
      return { write, writesStarted, order }
    }

    it('the write lands and the file closes: canceled (the stream closing as a result is no failure)', async () => {
      serverSends({ holdEnd: true })
      const { write, order } = heldWrite()
      const result = copy('copy-7')
      await write.entered

      expect(cancelBrowserServerDownloadCopy('copy-7')).toBe(true)
      write.release()

      await expect(result).resolves.toEqual({ canceled: true })
      // The outcome waited for the write under way, and the file closed only after it.
      expect(order).toEqual(['write done', 'close'])
      expect(await fs.readdir(downloads.path)).toEqual([])
      expect(await nameIsFree()).toBe(true)
    })

    it('the write fails on its own: that failure shows, not the cancel', async () => {
      serverSends({ holdEnd: true })
      const { write } = heldWrite()
      const result = copy('copy-8')
      await write.entered

      expect(cancelBrowserServerDownloadCopy('copy-8')).toBe(true)
      write.release(diskFull())

      await expect(result).rejects.toThrow('ENOSPC: no space left on device, write')
      expect(await fs.readdir(downloads.path)).toEqual([])
      expect(await nameIsFree()).toBe(true)
    })

    it('the write lands but the file reports a lost write on close: that shows', async () => {
      serverSends({ holdEnd: true })
      const { write } = heldWrite({ closeFails: true })
      const result = copy('copy-9')
      await write.entered

      expect(cancelBrowserServerDownloadCopy('copy-9')).toBe(true)
      write.release()

      await expect(result).rejects.toThrow('EIO: i/o error, close')
      expect(await fs.readdir(downloads.path)).toEqual([])
    })

    it('both the write and the close fail: the write failure, which came first, shows', async () => {
      serverSends({ holdEnd: true })
      const { write } = heldWrite({ closeFails: true })
      const result = copy('copy-10')
      await write.entered

      expect(cancelBrowserServerDownloadCopy('copy-10')).toBe(true)
      write.release(diskFull())

      await expect(result).rejects.toThrow('ENOSPC: no space left on device, write')
    })

    it('a failure that stopped it before Cancel shows over a later lost write on close', async () => {
      serverSends({ holdEnd: true })
      const { write } = heldWrite({ closeFails: true })
      const result = copy('copy-11')
      await write.entered

      server.callbacks?.onEvent({ type: 'error', code: 'gone', message: 'The server went away.' })
      cancelBrowserServerDownloadCopy('copy-11')
      write.release()

      await expect(result).rejects.toThrow('The server went away.')
    })

    it('starts no further write once canceled: not the rest of a short write, nor the next frame', async () => {
      const first = Buffer.alloc(BROWSER_DOWNLOAD_COPY_FRAME_BYTES, 1)
      serverSends({ holdEnd: true, parts: [first, Buffer.from(CONTENT)] })
      const { write, writesStarted, order } = heldWrite({ shortWrite: true })
      const result = copy('copy-12')
      await write.entered

      expect(cancelBrowserServerDownloadCopy('copy-12')).toBe(true)
      write.release()

      await expect(result).resolves.toEqual({ canceled: true })
      expect(order).toEqual(['write done', 'close'])
      expect(writesStarted.count).toBe(1)
      expect(await fs.readdir(downloads.path)).toEqual([])
    })
  })

  it('a Cancel that comes once the file is being moved into Downloads is refused, and it saves', async () => {
    serverSends({ holdEnd: false })
    withoutHardLinks()
    let admitted: boolean | null = null
    wrapWritable('new', (handle) => {
      const close = handle.close.bind(handle)
      return {
        close: async () => {
          admitted ??= cancelBrowserServerDownloadCopy('copy-13')
          await close()
        }
      }
    })

    const result = await copy('copy-13')

    const destinationPath = path.join(downloads.path, 'report.pdf')
    expect(admitted).toBe(false)
    expect(result).toEqual({ canceled: false, destinationPath })
    expect(await fs.readFile(destinationPath, 'utf8')).toBe(CONTENT)
    expect(await fs.readdir(downloads.path)).toEqual(['report.pdf'])
  })

  it('a refused Cancel does not stop a move into Downloads from failing visibly', async () => {
    serverSends({ holdEnd: false })
    withoutHardLinks()
    let admitted: boolean | null = null
    wrapWritable('new', (handle) => {
      const close = handle.close.bind(handle)
      return {
        close: async () => {
          admitted ??= cancelBrowserServerDownloadCopy('copy-14')
          await close()
          throw lostWrite()
        }
      }
    })
    const destinationPath = path.join(downloads.path, 'report.pdf')

    await expect(copy('copy-14')).rejects.toThrow(
      `Saving to ${destinationPath} stopped partway (EIO: i/o error, close). An incomplete file may be left there.`
    )
    expect(admitted).toBe(false)
    // The staging copy is gone; what was written into Downloads stays.
    expect(await fs.readdir(downloads.path)).toEqual(['report.pdf'])
    expect(releasedOnServer()).toEqual(['browser.releaseDownloadCopy'])
    expect(await nameIsFree()).toBe(true)
  })

  it('a failed move into Downloads never removes a file another app saved under its name', async () => {
    serverSends({ holdEnd: false })
    withoutHardLinks()
    const destinationPath = path.join(downloads.path, 'report.pdf')
    wrapWritable('new', (handle) => {
      const close = handle.close.bind(handle)
      return {
        close: async () => {
          await close()
          // Another app saves its own report.pdf (moved in, so a different file), then the close fails.
          const theirs = path.join(downloads.path, 'their-save')
          await fs.writeFile(theirs, 'theirs')
          await fs.rename(theirs, destinationPath)
          throw lostWrite()
        }
      }
    })

    const outcome = await copy('copy-15').then(
      () => null,
      (error: Error) => error
    )

    // Custody first, whatever the error says.
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('theirs')
    expect(await fs.readdir(downloads.path)).toEqual(['report.pdf'])
    expect(outcome?.message).toBe(
      `Saving to ${destinationPath} stopped partway (EIO: i/o error, close). An incomplete file may be left there.`
    )
  })
})
