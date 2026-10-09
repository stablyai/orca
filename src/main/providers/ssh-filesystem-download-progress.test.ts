import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SFTPWrapper } from 'ssh2'
import { downloadFileViaSftp, downloadFolderViaSftp } from './ssh-filesystem-download'
import { withSftpDirectoryHandles } from './sftp-directory-test-fixture'

function asSftp(fake: object): SFTPWrapper {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakes implement only the SFTP calls the download path makes.
  return fake as SFTPWrapper
}

type FastGetStep = (totalTransferred: number, chunk: number, total: number) => void

function sftpStats(kind: 'directory' | 'file') {
  return {
    size: kind === 'file' ? 6 : 0,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false
  }
}

function fastGetReporting(runningTotals: number[]) {
  return vi.fn(
    (
      _source: string,
      _destination: string,
      options: { step?: FastGetStep },
      callback: (err?: Error) => void
    ) => {
      for (const total of runningTotals) {
        options.step?.(total, 0, runningTotals.at(-1) ?? 0)
      }
      callback()
    }
  )
}

describe('SFTP download progress', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('turns ssh2 running totals into per-chunk byte deltas for a file', async () => {
    const sftp = { fastGet: fastGetReporting([3, 8, 8, 10]), end: vi.fn() }
    const onBytesTransferred = vi.fn()

    await downloadFileViaSftp(async () => asSftp(sftp), '/remote/a.bin', '/local/a.bin', {
      onBytesTransferred
    })

    expect(onBytesTransferred.mock.calls.map(([bytes]) => bytes)).toEqual([3, 5, 2])
    expect(sftp.end).toHaveBeenCalledTimes(1)
  })

  it('keeps the plain fastGet call when nobody observes progress', async () => {
    const fastGet = vi.fn((_s: string, _d: string, callback: (err?: Error) => void) => callback())
    const sftp = { fastGet, end: vi.fn() }

    await downloadFileViaSftp(async () => asSftp(sftp), '/remote/a.bin', '/local/a.bin')

    expect(fastGet).toHaveBeenCalledWith('/remote/a.bin', '/local/a.bin', expect.any(Function))
  })

  it('closes the SFTP channel when a file download is canceled mid-transfer', async () => {
    const controller = new AbortController()
    let finish: ((err?: Error) => void) | undefined
    const sftp = {
      fastGet: vi.fn((_s: string, _d: string, _o: unknown, callback: (err?: Error) => void) => {
        finish = callback
      }),
      end: vi.fn(() => finish?.(new Error('channel closed')))
    }

    const download = downloadFileViaSftp(async () => asSftp(sftp), '/remote/a', '/local/a', {
      signal: controller.signal,
      onBytesTransferred: vi.fn()
    })
    await vi.waitFor(() => expect(sftp.fastGet).toHaveBeenCalled())
    controller.abort(new Error('Download canceled'))

    await expect(download).rejects.toThrow('Download canceled')
    expect(sftp.end).toHaveBeenCalledTimes(1)
  })

  it('reports bytes and completed files across a folder tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-progress-'))
    roots.push(root)
    const listings: Record<string, unknown[]> = {
      '/remote/src': [
        { filename: 'a.txt', longname: 'a.txt', attrs: sftpStats('file') },
        { filename: 'lib', longname: 'lib', attrs: sftpStats('directory') }
      ],
      '/remote/src/lib': [{ filename: 'b.txt', longname: 'b.txt', attrs: sftpStats('file') }]
    }
    const sftp = {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, listings[path])
      ),
      fastGet: fastGetReporting([4, 6]),
      end: vi.fn()
    }
    const onBytesTransferred = vi.fn()
    const onFileCompleted = vi.fn()
    const onTotalBytes = vi.fn()

    await downloadFolderViaSftp(
      async () => withSftpDirectoryHandles(sftp),
      '/remote/src',
      join(root, 'src'),
      {
        onTotalBytes,
        onBytesTransferred,
        onFileCompleted
      }
    )

    expect(onTotalBytes).toHaveBeenCalledWith(12)
    expect(onFileCompleted).toHaveBeenCalledTimes(2)
    const total = onBytesTransferred.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0)
    expect(total).toBe(12)
  })

  function folderSftp(onReaddir: () => void = () => {}) {
    const listings: Record<string, unknown[]> = {
      '/remote/src': [
        { filename: 'a.txt', longname: 'a.txt', attrs: sftpStats('file') },
        { filename: 'lib', longname: 'lib', attrs: sftpStats('directory') }
      ],
      '/remote/src/lib': [{ filename: 'b.txt', longname: 'b.txt', attrs: sftpStats('file') }]
    }
    return {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((path: string, callback: (err: Error | undefined, value: unknown) => void) => {
        onReaddir()
        callback(undefined, listings[path])
      }),
      fastGet: fastGetReporting([6]),
      end: vi.fn()
    }
  }

  it('supplies the total while the download is still moving bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-walk-late-'))
    roots.push(root)
    const sftp = folderSftp()
    const onTotalBytes = vi.fn()
    // The first file waits until the walk has reported, so the total lands while bytes still move.
    const firstFileGate = Promise.withResolvers<void>()
    onTotalBytes.mockImplementation(() => firstFileGate.resolve())
    const plainFastGet = sftp.fastGet
    sftp.fastGet = vi.fn((...args: Parameters<typeof plainFastGet>) => {
      void firstFileGate.promise.then(() => plainFastGet(...args))
    })
    await downloadFolderViaSftp(
      async () => withSftpDirectoryHandles(sftp),
      '/remote/src',
      join(root, 'src'),
      {
        onTotalBytes,
        onBytesTransferred: vi.fn()
      }
    )

    expect(onTotalBytes).toHaveBeenCalledWith(12)
    expect(sftp.fastGet).toHaveBeenCalledTimes(2)
  })

  it('finishes the download when the total observer throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-observer-throws-'))
    roots.push(root)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const sftp = folderSftp()
    try {
      await downloadFolderViaSftp(
        async () => withSftpDirectoryHandles(sftp),
        '/remote/src',
        join(root, 'src'),
        {
          onTotalBytes: () => {
            throw new Error('observer failed')
          },
          onBytesTransferred: vi.fn()
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', unhandled)
    }

    expect(unhandled).not.toHaveBeenCalled()
    expect(sftp.fastGet).toHaveBeenCalledTimes(2)
  })

  it('does not wait for a slow walk, and drops a total that arrives after the download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-walk-slow-'))
    roots.push(root)
    const sftp = folderSftp()
    const answer = sftp.readdir.getMockImplementation()!
    let heldWalk: (() => void) | undefined
    // Why: the walk issues the first listing; holding it leaves the walk running past the download.
    sftp.readdir.mockImplementationOnce((path, callback) => {
      heldWalk = () => answer(path, callback)
    })
    const onTotalBytes = vi.fn()

    await downloadFolderViaSftp(
      async () => withSftpDirectoryHandles(sftp),
      '/remote/src',
      join(root, 'src'),
      {
        onTotalBytes,
        onBytesTransferred: vi.fn()
      }
    )
    expect(sftp.fastGet).toHaveBeenCalledTimes(2)
    heldWalk?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onTotalBytes).not.toHaveBeenCalled()
  })

  it('still downloads everything when the size walk fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-walk-fail-'))
    roots.push(root)
    const sftp = folderSftp()
    sftp.readdir.mockImplementationOnce((_path, callback) =>
      callback(new Error('Permission denied'), undefined)
    )
    const onTotalBytes = vi.fn()

    await downloadFolderViaSftp(
      async () => withSftpDirectoryHandles(sftp),
      '/remote/src',
      join(root, 'src'),
      {
        onTotalBytes,
        onBytesTransferred: vi.fn()
      }
    )

    expect(onTotalBytes).not.toHaveBeenCalled()
    expect(sftp.fastGet).toHaveBeenCalledTimes(2)
  })

  it('starts no file transfer when cancelled while the folder is still being measured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-measure-cancel-'))
    roots.push(root)
    const controller = new AbortController()
    const sftp = folderSftp(() => controller.abort(new Error('Download canceled')))

    await expect(
      downloadFolderViaSftp(
        async () => withSftpDirectoryHandles(sftp),
        '/remote/src',
        join(root, 'src'),
        {
          signal: controller.signal,
          onTotalBytes: vi.fn()
        }
      )
    ).rejects.toThrow('Download canceled')
    expect(sftp.fastGet).not.toHaveBeenCalled()
  })
})
