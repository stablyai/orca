import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper, WriteStreamOptions } from 'ssh2'
import { SFTP } from 'ssh2/lib/protocol/SFTP.js'
import { uploadDirectory } from './sftp-upload'
import { uploadFile } from './sftp-file-upload'

function createWritable(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    }
  })
}

function createSftpMock(): SFTPWrapper {
  const session = new EventEmitter()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests call only the methods stubbed here and the session's events.
  return Object.assign(session, {
    end: () => session.emit('close'),
    mkdir: vi.fn((_path: string, cb: (err?: Error | null) => void) => cb(null)),
    createWriteStream: vi.fn(() => createWritable()),
    readdir: vi.fn((_path: string, cb: (err?: Error | null, entries?: unknown[]) => void) =>
      cb(null, [])
    ),
    unlink: vi.fn((_path: string, cb: (err?: Error | null) => void) => cb(null)),
    rmdir: vi.fn((_path: string, cb: (err?: Error | null) => void) => cb(null))
  }) as unknown as SFTPWrapper
}

describe('sftp-upload', () => {
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
      // Use a Windows junction to exercise rejection without symlink privileges.
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
})

describe('uploadFile over a high-latency link', () => {
  // ssh2's own WriteStream over a fake session whose every request takes one "round trip".
  function slowSftp(
    roundTripMs: number,
    stallAfterWrites = Number.POSITIVE_INFINITY
  ): {
    sftp: SFTPWrapper
    written: Map<number, Buffer>
    maxInFlight: () => number
  } {
    let inFlight = 0
    let peak = 0
    const written = new Map<number, Buffer>()
    // A dead link: once stalled, no request (WRITE or the stream's CLOSE) is ever answered.
    const later = (cb: () => void): void => {
      if (written.size <= stallAfterWrites) {
        setTimeout(cb, roundTripMs)
      }
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

  it('fails, as contact lost, when the SSH session closes under a stalled upload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-'))
    await writeFile(join(dir, 'node.tar.gz'), Buffer.alloc(8 * 1024 * 1024))
    const { sftp, written } = slowSftp(1, 4)
    try {
      const upload = uploadFile(sftp, join(dir, 'node.tar.gz'), '/remote/node.tar.gz')
      await vi.waitFor(() => expect(written.size).toBeGreaterThan(4))
      sftp.emit('close')
      await expect(upload).rejects.toMatchObject({
        name: 'SftpSessionClosedError',
        sshChannelCloseConfirmed: false
      })
      expect(sftp.listenerCount('close')).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
