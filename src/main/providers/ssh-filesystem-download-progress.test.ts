import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SFTPWrapper } from 'ssh2'
import { downloadFileViaSftp, downloadFolderViaSftp } from './ssh-filesystem-download'

function asSftp(fake: object): SFTPWrapper {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakes implement only the SFTP calls the download path makes.
  return fake as SFTPWrapper
}

type FastGetStep = (totalTransferred: number, chunk: number, total: number) => void

function sftpStats(kind: 'directory' | 'file') {
  return {
    size: 0,
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

    await downloadFolderViaSftp(async () => asSftp(sftp), '/remote/src', join(root, 'src'), {
      onBytesTransferred,
      onFileCompleted
    })

    expect(onFileCompleted).toHaveBeenCalledTimes(2)
    const total = onBytesTransferred.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0)
    expect(total).toBe(12)
  })
})
