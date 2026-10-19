import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper, WriteStreamOptions } from 'ssh2'
import { SFTP } from 'ssh2/lib/protocol/SFTP.js'
import {
  removeDirectorySftp,
  SFTP_UPLOAD_IN_FLIGHT_BYTES,
  uploadBuffer,
  uploadDirectory,
  uploadFile
} from './sftp-upload'

function createWritable(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    }
  })
}

function createSftpMock(): SFTPWrapper {
  return {
    mkdir: vi.fn((_path: string, cb: (err?: Error | null) => void) => cb(null)),
    createWriteStream: vi.fn(() => createWritable()),
    readdir: vi.fn((_path: string, cb: (err?: Error | null, entries?: unknown[]) => void) =>
      cb(null, [])
    ),
    unlink: vi.fn((_path: string, cb: (err?: Error | null) => void) => cb(null)),
    rmdir: vi.fn((_path: string, cb: (err?: Error | null) => void) => cb(null))
  } as unknown as SFTPWrapper
}

describe('sftp-upload', () => {
  it('can create the first binary upload chunk without clobbering an existing temp file', async () => {
    const sftp = createSftpMock()

    await uploadBuffer(sftp, Buffer.from('png'), '/remote/.logo.orca-upload', {
      exclusive: true
    })

    expect(sftp.createWriteStream).toHaveBeenCalledWith('/remote/.logo.orca-upload', {
      flags: 'wx'
    })
    const writeStream = vi.mocked(sftp.createWriteStream).mock.results[0]?.value as Writable
    expect(writeStream.listenerCount('close')).toBe(0)
    // One durable 'error' listener stays for the stream's whole life: a STATUS reply that
    // lands after the transfer settles must not throw into ssh2's parser (#15479).
    expect(writeStream.listenerCount('error')).toBe(1)
  })

  it('uses no-clobber writes for nested files during exclusive directory upload', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-'))
    await mkdir(join(localDir, 'nested'))
    await writeFile(join(localDir, 'nested', 'asset.txt'), 'asset')
    const sftp = createSftpMock()

    await uploadDirectory(sftp, localDir, '/remote/assets', await realpath(localDir), {
      exclusive: true
    })

    expect(sftp.mkdir).toHaveBeenCalledWith('/remote/assets/nested', expect.any(Function))
    expect(sftp.createWriteStream).toHaveBeenCalledWith('/remote/assets/nested/asset.txt', {
      flags: 'wx',
      highWaterMark: SFTP_UPLOAD_IN_FLIGHT_BYTES
    })
    const writeStream = vi.mocked(sftp.createWriteStream).mock.results[0]?.value as Writable
    expect(writeStream.listenerCount('close')).toBe(0)
    // One durable 'error' listener stays for the stream's whole life: a STATUS reply that
    // lands after the transfer settles must not throw into ssh2's parser (#15479).
    expect(writeStream.listenerCount('error')).toBe(1)
  })

  it('uploads files from valid dot-dot-prefixed local directories', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-'))
    await mkdir(join(localDir, '..fixtures'))
    await writeFile(join(localDir, '..fixtures', 'asset.txt'), 'asset')
    const sftp = createSftpMock()

    await uploadDirectory(sftp, localDir, '/remote/assets', await realpath(localDir), {
      exclusive: true
    })

    expect(sftp.mkdir).toHaveBeenCalledWith('/remote/assets/..fixtures', expect.any(Function))
    expect(sftp.createWriteStream).toHaveBeenCalledWith('/remote/assets/..fixtures/asset.txt', {
      flags: 'wx',
      highWaterMark: SFTP_UPLOAD_IN_FLIGHT_BYTES
    })
  })

  it('accepts a root named through a symlink or short name that realpath rewrites', async () => {
    const realDir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-'))
    await writeFile(join(realDir, 'asset.txt'), 'asset')
    const aliasDir = `${realDir}-alias`
    // Why a junction on Windows: directory symlinks need Developer Mode or admin there.
    await symlink(realDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir')
    const sftp = createSftpMock()

    await uploadDirectory(sftp, aliasDir, '/remote/assets')

    expect(sftp.createWriteStream).toHaveBeenCalledWith('/remote/assets/asset.txt', {
      flags: 'w',
      highWaterMark: SFTP_UPLOAD_IN_FLIGHT_BYTES
    })
    await rm(aliasDir, { force: true })
    await rm(realDir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'uploads a root reached through a symlinked parent',
    async () => {
      const realParent = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-'))
      await mkdir(join(realParent, 'root'))
      await writeFile(join(realParent, 'root', 'asset.txt'), 'asset')
      const linkedParent = `${realParent}-link`
      await symlink(realParent, linkedParent)
      try {
        const localDir = join(linkedParent, 'root')
        const sftp = createSftpMock()

        await uploadDirectory(sftp, localDir, '/remote/assets', localDir)

        expect(sftp.createWriteStream).toHaveBeenCalledWith('/remote/assets/asset.txt', {
          flags: 'w',
          highWaterMark: SFTP_UPLOAD_IN_FLIGHT_BYTES
        })
      } finally {
        await rm(linkedParent, { force: true })
        await rm(realParent, { recursive: true, force: true })
      }
    }
  )

  it('rejects sibling directories outside the upload root', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-'))
    const escapedDir = `${localDir}-sibling`
    await mkdir(escapedDir)
    await writeFile(join(escapedDir, 'asset.txt'), 'asset')
    const sftp = createSftpMock()

    await expect(
      uploadDirectory(sftp, escapedDir, '/remote/assets', await realpath(localDir), {
        exclusive: true
      })
    ).rejects.toThrow('Path escaped upload root')

    expect(sftp.mkdir).not.toHaveBeenCalled()
    expect(sftp.createWriteStream).not.toHaveBeenCalled()
  })

  it('does not create the remote file when the local source is a symlink', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-'))
    const targetPath = join(localDir, process.platform === 'win32' ? 'target-dir' : 'target.txt')
    const linkPath = join(localDir, process.platform === 'win32' ? 'link-dir' : 'link.txt')
    if (process.platform === 'win32') {
      await mkdir(targetPath)
      // Why: file symlinks often require Developer Mode/admin on Windows, while
      // junctions still exercise the symlink rejection branch.
      await symlink(targetPath, linkPath, 'junction')
    } else {
      await writeFile(targetPath, 'secret')
      await symlink(targetPath, linkPath)
    }
    const sftp = createSftpMock()

    await expect(uploadFile(sftp, linkPath, '/remote/link.txt')).rejects.toThrow()

    expect(sftp.createWriteStream).not.toHaveBeenCalled()
  })

  it('joins local file-descriptor teardown when a live upload is aborted', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-abort-'))
    const localPath = join(localDir, 'relay.js')
    const controller = new AbortController()
    const blockedWrite = new Writable({
      write() {}
    })
    const sftp = createSftpMock()
    vi.mocked(sftp.createWriteStream).mockReturnValue(blockedWrite as never)
    try {
      await writeFile(localPath, Buffer.alloc(1024 * 1024, 7))
      const upload = uploadFile(sftp, localPath, '/remote/relay.js', {
        signal: controller.signal
      })
      await vi.waitFor(() => expect(sftp.createWriteStream).toHaveBeenCalledTimes(1))

      controller.abort()

      await expect(upload).rejects.toMatchObject({ name: 'AbortError' })
      if (process.platform !== 'win32') {
        const descriptorProbe = spawnSync(
          'lsof',
          ['-a', '-p', String(process.pid), '--', localPath],
          { encoding: 'utf8' }
        )
        if (!descriptorProbe.error) {
          expect(descriptorProbe.stdout).not.toContain(localPath)
        }
      }
    } finally {
      await rm(localDir, { recursive: true, force: true })
    }
  })

  it('never throws an uncaught error when a quit aborts an upload whose read already ended', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-quit-'))
    const localPath = join(localDir, 'orcad.js')
    const controller = new AbortController()
    // Accepts every byte but never finishes, as a remote write still flushing at quit does.
    const flushing = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
      final() {}
    })
    const sftp = createSftpMock()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the upload only pipes into and awaits this stream.
    vi.mocked(sftp.createWriteStream).mockReturnValue(flushing as never)
    const uncaught = vi.fn()
    process.prependListener('uncaughtException', uncaught)
    try {
      await writeFile(localPath, Buffer.alloc(64 * 1024, 7))
      const upload = uploadFile(sftp, localPath, '/remote/orcad.js', { signal: controller.signal })
      upload.catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 50))

      // The quit's disconnect aborts with the signal's own AbortError as the reason.
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(uncaught).not.toHaveBeenCalled()
    } finally {
      process.off('uncaughtException', uncaught)
      flushing.destroy()
      await rm(localDir, { recursive: true, force: true })
    }
  })

  it('joins the local read when the remote write fails', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-failure-'))
    const localPath = join(localDir, 'relay.js')
    const sftp = createSftpMock()
    vi.mocked(sftp.createWriteStream).mockReturnValue(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error('remote write failed'))
        }
      }) as never
    )
    try {
      await writeFile(localPath, Buffer.alloc(1024 * 1024, 7))

      await expect(uploadFile(sftp, localPath, '/remote/relay.js')).rejects.toThrow(
        'remote write failed'
      )
    } finally {
      await rm(localDir, { recursive: true, force: true })
    }
  })

  it('removes remote directory contents before removing the directory', async () => {
    const sftp = createSftpMock()
    vi.mocked(sftp.readdir).mockImplementation((remotePath, cb) => {
      const pathString = String(remotePath)
      if (pathString === '/remote/assets') {
        cb(undefined, [
          { filename: '.', attrs: { isDirectory: () => true } },
          { filename: '..', attrs: { isDirectory: () => true } },
          { filename: 'nested', attrs: { isDirectory: () => true } },
          { filename: 'logo.png', attrs: { isDirectory: () => false } }
        ] as never)
        return
      }
      if (pathString === '/remote/assets/nested') {
        cb(undefined, [{ filename: 'copy.txt', attrs: { isDirectory: () => false } }] as never)
        return
      }
      cb(new Error(`unexpected readdir: ${pathString}`), [] as never)
    })

    await removeDirectorySftp(sftp, '/remote/assets')

    expect(sftp.unlink).toHaveBeenNthCalledWith(
      1,
      '/remote/assets/nested/copy.txt',
      expect.any(Function)
    )
    expect(sftp.rmdir).toHaveBeenNthCalledWith(1, '/remote/assets/nested', expect.any(Function))
    expect(sftp.unlink).toHaveBeenNthCalledWith(2, '/remote/assets/logo.png', expect.any(Function))
    expect(sftp.rmdir).toHaveBeenNthCalledWith(2, '/remote/assets', expect.any(Function))
  })
})

describe('uploadFile over a high-latency link', () => {
  // ssh2's own WriteStream over a fake session whose every request takes one "round trip".
  function slowSftp(roundTripMs: number): {
    sftp: SFTPWrapper
    written: Map<number, Buffer>
    maxInFlight: () => number
  } {
    let inFlight = 0
    let peak = 0
    const written = new Map<number, Buffer>()
    const later = (cb: () => void): void => {
      setTimeout(cb, roundTripMs)
    }
    const session = Object.assign(new EventEmitter(), {
      server: false,
      open: (_path: string, _flags: string, _mode: number, cb: (e: null, h: Buffer) => void) =>
        later(() => cb(null, Buffer.from('h'))),
      fchmod: (_h: Buffer, _mode: number, cb: (e: null) => void) => later(() => cb(null)),
      write: (
        _h: Buffer,
        buf: Buffer,
        off: number,
        len: number,
        pos: number,
        cb: (e: null, n: number) => void
      ) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        written.set(pos, Buffer.from(buf.subarray(off, off + len)))
        later(() => {
          inFlight -= 1
          cb(null, len)
        })
      },
      close: (_h: Buffer, cb: (e: null) => void) => later(() => cb(null))
    })
    const sftp = Object.assign(session, {
      createWriteStream: (path: string, options: WriteStreamOptions) =>
        SFTP.prototype.createWriteStream.call(session, path, options)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: uploadFile only calls createWriteStream, which drives open/fchmod/write/close above.
    return { sftp: sftp as unknown as SFTPWrapper, written, maxInFlight: () => peak }
  }

  it('keeps many writes in flight instead of one chunk per round trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-'))
    const contents = Buffer.alloc(4 * 1024 * 1024)
    for (let i = 0; i < contents.length; i += 4096) {
      contents[i] = i % 251
    }
    await writeFile(join(dir, 'node.tar.gz'), contents)
    const { sftp, written, maxInFlight } = slowSftp(20)
    try {
      await uploadFile(sftp, join(dir, 'node.tar.gz'), '/remote/node.tar.gz')
      // One 64 KiB read chunk per round trip would keep a single write in flight.
      expect(maxInFlight()).toBeGreaterThanOrEqual(8)
      const reassembled = Buffer.concat(
        [...written.entries()].sort(([a], [b]) => a - b).map(([, chunk]) => chunk)
      )
      expect(reassembled.equals(contents)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
