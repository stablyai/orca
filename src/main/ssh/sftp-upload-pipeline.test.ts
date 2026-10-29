import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { SFTPWrapper, WriteStreamOptions } from 'ssh2'
import { SFTP } from 'ssh2/lib/protocol/SFTP.js'
import { describe, expect, it, vi } from 'vitest'
import { uploadSshDirectory } from './connection/ssh-connection-file-transfers'
import { uploadDirectory } from './sftp-upload'

function uploadSession(options?: {
  stalledCloses?: boolean
  heldWrite?: string
  confirmEnd?: boolean
}) {
  const contents = new Map<string, Map<number, Buffer>>()
  const windows = new Map<string, number>()
  const opened: string[] = []
  const directories = new Set(['/remote'])
  const closes = new Map<string, () => void>()
  let rejectWrite: ((error: Error) => void) | undefined
  let stallCloses = options?.stalledCloses ?? false
  let peakHandles = 0
  let peakWindow = 0
  let ended = false
  const later = (callback: () => void): void => {
    setImmediate(() => {
      if (!ended) {
        callback()
      }
    })
  }
  const session = Object.assign(new EventEmitter(), {
    server: false,
    open: (
      path: string,
      _flags: string,
      _mode: number,
      cb: (e: Error | null, h?: Buffer) => void
    ) =>
      later(() => {
        if (!directories.has(posix.dirname(path))) {
          cb(new Error('parent directory missing'))
          return
        }
        opened.push(path)
        contents.set(path, new Map())
        cb(null, Buffer.from(path))
      }),
    fchmod: (_handle: Buffer, _mode: number, cb: (e: null) => void) => later(() => cb(null)),
    write: (
      handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: (e: Error | null, n?: number) => void
    ) => {
      const path = handle.toString()
      contents.get(path)?.set(position, Buffer.from(buffer.subarray(offset, offset + length)))
      if (path === options?.heldWrite) {
        rejectWrite = (error) => cb(error)
      } else {
        later(() => cb(null, length))
      }
    },
    close: (handle: Buffer, cb: (e: null) => void) => {
      const path = handle.toString()
      if (stallCloses && path !== options?.heldWrite) {
        closes.set(path, () => cb(null))
      } else {
        later(() => cb(null))
      }
    },
    mkdir: (path: string, cb: (e: null) => void) =>
      later(() => {
        directories.add(path)
        cb(null)
      }),
    end: vi.fn(() => {
      ended = true
      if (options?.confirmEnd !== false) {
        session.emit('close')
      }
    })
  })
  const sftp = Object.assign(session, {
    createWriteStream: (path: string, streamOptions: WriteStreamOptions) => {
      const stream = SFTP.prototype.createWriteStream.call(session, path, streamOptions)
      windows.set(path, stream.writableHighWaterMark)
      peakHandles = Math.max(peakHandles, windows.size)
      peakWindow = Math.max(
        peakWindow,
        [...windows.values()].reduce((sum, size) => sum + size, 0)
      )
      stream.once('close', () => windows.delete(path))
      return stream
    }
  })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh2's real WriteStream uses the session methods implemented above.
    sftp: sftp as unknown as SFTPWrapper,
    contents,
    windows,
    opened,
    closes,
    peakHandles: () => peakHandles,
    peakWindow: () => peakWindow,
    failWrite: (error: Error) => {
      if (!rejectWrite) {
        throw new Error('the held WRITE has not arrived')
      }
      rejectWrite(error)
    },
    releaseCloses: () => {
      stallCloses = false
      for (const close of closes.values()) {
        close()
      }
      closes.clear()
    }
  }
}

function uploadThroughConnection(
  sftp: SFTPWrapper,
  localDir: string,
  operation = new AbortController().signal
): Promise<void> {
  return uploadSshDirectory(
    {
      target: { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' },
      usesSystemSshTransport: () => false,
      systemOperationSignal: () => operation,
      systemSshBuildArgsOptions: () => ({}),
      sftp: async () => sftp
    },
    localDir,
    '/remote'
  )
}

async function openLocalFiles(dir: string): Promise<string[]> {
  const targets = await Promise.allSettled(
    (await readdir('/proc/self/fd')).map((fd) => readlink(`/proc/self/fd/${fd}`))
  )
  return targets.flatMap((target) =>
    target.status === 'fulfilled' && target.value.startsWith(dir) ? [target.value] : []
  )
}

async function expectLocalFilesClosed(dir: string): Promise<void> {
  if (process.platform !== 'linux') {
    return
  }
  // /proc/self/fd can list an fd for a few ms after FileHandle.close() resolves; a leaked handle never clears.
  await vi.waitFor(async () => expect(await openLocalFiles(dir)).toEqual([]), { timeout: 2_000 })
}

describe('directory upload pipeline', () => {
  it('overlaps four small files, preserves bytes, and creates parents before child writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-sftp-pipeline-'))
    const fixture = uploadSession({ stalledCloses: true })
    const files = new Map<string, Buffer>()
    let upload: Promise<void> | undefined
    try {
      await mkdir(join(dir, 'nested'))
      for (let index = 0; index < 12; index++) {
        const path = index < 6 ? `${index}.bin` : `nested/${index}.bin`
        const contents = Buffer.alloc(1024 + index * 521, index)
        files.set(`/remote/${path}`, contents)
        await writeFile(join(dir, path), contents)
      }
      upload = uploadDirectory(fixture.sftp, dir, '/remote', dir, { exclusive: true })
      void upload.catch(() => {})
      await vi.waitFor(() => expect(fixture.closes.size).toBe(4))
      expect(fixture.opened).toHaveLength(4)
      fixture.releaseCloses()
      await upload

      expect(fixture.peakHandles()).toBe(4)
      expect(fixture.peakWindow()).toBe(4 * 64 * 1024)
      expect(fixture.windows.size).toBe(0)
      expect(fixture.contents.size).toBe(files.size)
      for (const [path, expected] of files) {
        const pieces = fixture.contents.get(path)
        expect(pieces).toBeDefined()
        const actual = Buffer.concat(
          [...(pieces ?? [])].sort(([a], [b]) => a - b).map(([, chunk]) => chunk)
        )
        expect(actual.equals(expected)).toBe(true)
      }
    } finally {
      fixture.releaseCloses()
      fixture.sftp.emit('close')
      await upload?.catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('preserves the first write failure while closing a sibling stalled in CLOSE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-sftp-pipeline-'))
    const settings = { stalledCloses: true, heldWrite: '' }
    const fixture = uploadSession(settings)
    try {
      for (let index = 0; index < 8; index++) {
        await writeFile(join(dir, `${index}.bin`), Buffer.alloc(1024, index))
      }
      settings.heldWrite = `/remote/${(await readdir(dir))[0]}`
      const outcome = uploadThroughConnection(fixture.sftp, dir).catch((error: unknown) => error)
      await vi.waitFor(() => expect(fixture.closes.size).toBe(3))
      const firstError = new Error('remote disk is full')
      fixture.failWrite(firstError)

      expect(await outcome).toBe(firstError)
      expect(firstError).toMatchObject({
        sshChannelCloseConfirmed: true,
        sshTransferTeardownConfirmed: true
      })
      expect(fixture.opened).toHaveLength(4)
      expect(fixture.sftp.end).toHaveBeenCalledTimes(1)
      expect(fixture.sftp.listenerCount('close')).toBe(0)
      await expectLocalFilesClosed(dir)
    } finally {
      fixture.releaseCloses()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('bounds an unconfirmed failure close and retains the install-lock uncertainty flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-sftp-pipeline-'))
    const fixture = uploadSession({
      stalledCloses: true,
      heldWrite: '/remote/0.bin',
      confirmEnd: false
    })
    try {
      await writeFile(join(dir, '0.bin'), Buffer.alloc(1024))
      await writeFile(join(dir, '1.bin'), Buffer.alloc(1024))
      const outcome = uploadThroughConnection(fixture.sftp, dir).catch((error: unknown) => error)
      await vi.waitFor(() => expect(fixture.closes.size).toBe(1))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const firstError = new Error('remote disk is full')
      fixture.failWrite(firstError)
      await vi.waitFor(() => expect(fixture.sftp.end).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(5_000)

      expect(await outcome).toBe(firstError)
      expect(firstError).toMatchObject({
        sshChannelCloseConfirmed: false,
        sshTransferTeardownConfirmed: false
      })
      await expectLocalFilesClosed(dir)
    } finally {
      fixture.sftp.emit('close')
      fixture.releaseCloses()
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops admission and closes local handles on abort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-sftp-pipeline-'))
    const fixture = uploadSession({ stalledCloses: true })
    const controller = new AbortController()
    try {
      for (let index = 0; index < 12; index++) {
        await writeFile(join(dir, `${index}.bin`), Buffer.alloc(1024))
      }
      const outcome = uploadThroughConnection(fixture.sftp, dir, controller.signal).catch(
        (error: unknown) => error
      )
      await vi.waitFor(() => expect(fixture.closes.size).toBe(4))
      controller.abort()

      // Teardown confirmation pins abort settling only after every transfer closed its local file.
      expect(await outcome).toMatchObject({
        name: 'AbortError',
        sshChannelCloseConfirmed: true,
        sshTransferTeardownConfirmed: true
      })
      expect(fixture.opened).toHaveLength(4)
      await expectLocalFilesClosed(dir)
    } finally {
      fixture.releaseCloses()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
