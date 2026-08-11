import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { downloadFolderViaSftp } from './ssh-filesystem-download'

type SftpEntryKind = 'directory' | 'file' | 'symlink' | 'fifo'

function sftpStats(kind: SftpEntryKind) {
  return {
    size: 0,
    mode: 0,
    uid: 0,
    gid: 0,
    atime: 0,
    mtime: 0,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
    isFIFO: () => kind === 'fifo',
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false
  }
}

function sftpEntry(filename: string, kind: SftpEntryKind) {
  return { filename, longname: filename, attrs: sftpStats(kind) }
}

describe('downloadFolderViaSftp', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function createDestination(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-download-'))
    roots.push(root)
    return join(root, 'src')
  }

  it('uses exclusive local reservations instead of guessing destination case sensitivity', async () => {
    const destination = await createDestination()
    let transferCount = 0
    const sftp = {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, [sftpEntry('A.txt', 'file'), sftpEntry('a.txt', 'file')])
      ),
      fastGet: vi.fn((_source: string, _destination: string, callback: (err?: Error) => void) => {
        transferCount += 1
        if (transferCount === 1) {
          void writeFile(join(destination, 'a.txt'), 'claimed').then(() => callback())
          return
        }
        callback()
      }),
      end: vi.fn()
    }

    await expect(
      downloadFolderViaSftp(async () => sftp as never, '/remote/src', destination)
    ).rejects.toThrow("Remote entries map to the same local name 'a.txt'")
    expect(sftp.fastGet).toHaveBeenCalledTimes(1)
  })

  it('rejects special remote entries before SFTP tries to open them', async () => {
    const destination = await createDestination()
    const sftp = {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, [sftpEntry('build.pipe', 'fifo')])
      ),
      fastGet: vi.fn(),
      end: vi.fn()
    }

    await expect(
      downloadFolderViaSftp(async () => sftp as never, '/remote/src', destination)
    ).rejects.toThrow("Cannot download unsupported remote entry 'build.pipe'")
    expect(sftp.fastGet).not.toHaveBeenCalled()
  })

  it('rejects a file symlink that could escape the selected remote tree', async () => {
    const destination = await createDestination()
    const sftp = {
      stat: vi.fn(
        (remotePath: string, callback: (err: Error | undefined, value: unknown) => void) =>
          callback(undefined, sftpStats(remotePath === '/remote/src' ? 'directory' : 'file'))
      ),
      readdir: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, [sftpEntry('creds', 'symlink')])
      ),
      fastGet: vi.fn(),
      end: vi.fn()
    }

    await expect(
      downloadFolderViaSftp(async () => sftp as never, '/remote/src', destination)
    ).rejects.toThrow("Cannot download symbolic link 'creds'")
    // The link target could be /etc/passwd; rejecting from directory-entry
    // metadata means it is never followed with stat or opened by fastGet.
    expect(sftp.stat).toHaveBeenCalledTimes(1)
    expect(sftp.fastGet).not.toHaveBeenCalled()
  })

  it('sanitizes extended Windows device names in nested entries', async () => {
    const destination = await createDestination()
    const sftp = {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, [sftpEntry('CONIN$', 'file'), sftpEntry('COM¹.txt', 'file')])
      ),
      fastGet: vi.fn(),
      end: vi.fn()
    }

    await expect(
      downloadFolderViaSftp(async () => sftp as never, '/remote/src', destination)
    ).rejects.toThrow("Remote entries map to the same local name 'download'")
    expect(sftp.fastGet).not.toHaveBeenCalled()
  })

  it('preserves legal POSIX backslashes in opaque SFTP child names', async () => {
    const destination = await createDestination()
    const sourcePath = '/remote/parent\\literal'
    const sftp = {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, [sftpEntry('..\\secret.txt', 'file')])
      ),
      fastGet: vi.fn((_source: string, _destination: string, callback: (err?: Error) => void) =>
        callback()
      ),
      end: vi.fn()
    }

    await downloadFolderViaSftp(async () => sftp as never, sourcePath, destination, {
      windowsRemotePaths: false
    })

    expect(sftp.fastGet).toHaveBeenCalledWith(
      '/remote/parent\\literal/..\\secret.txt',
      join(destination, '.._secret.txt'),
      expect.any(Function)
    )
  })

  it('rejects Windows-path traversal names when the remote host is Windows', async () => {
    const destination = await createDestination()
    const sftp = {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, [sftpEntry('..\\secret.txt', 'file')])
      ),
      fastGet: vi.fn(),
      end: vi.fn()
    }

    await expect(
      downloadFolderViaSftp(async () => sftp as never, 'C:/remote/src', destination, {
        windowsRemotePaths: true
      })
    ).rejects.toThrow("Invalid remote directory entry '..\\secret.txt'")
    expect(sftp.fastGet).not.toHaveBeenCalled()
  })

  it('waits for active SFTP file handles to quiesce when canceled', async () => {
    const destination = await createDestination()
    let fastGetCallback: ((error?: Error) => void) | undefined
    const sftp = {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, [sftpEntry('first.txt', 'file'), sftpEntry('second.txt', 'file')])
      ),
      fastGet: vi.fn((_source: string, _destination: string, callback: (error?: Error) => void) => {
        fastGetCallback = callback
      }),
      end: vi.fn()
    }
    const controller = new AbortController()

    const result = downloadFolderViaSftp(async () => sftp as never, '/remote/src', destination, {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(sftp.fastGet).toHaveBeenCalledTimes(1))
    controller.abort(new Error('renderer closed'))

    let settled = false
    void result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    fastGetCallback?.(new Error('channel closed'))

    await expect(result).rejects.toThrow('renderer closed')
    expect(sftp.fastGet).toHaveBeenCalledTimes(1)
    expect(sftp.end).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending SFTP directory read', async () => {
    const destination = await createDestination()
    let readDirCallback: ((error?: Error) => void) | undefined
    const sftp = {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((_path: string, callback: (error?: Error) => void) => {
        readDirCallback = callback
      }),
      fastGet: vi.fn(),
      end: vi.fn()
    }
    const controller = new AbortController()

    const result = downloadFolderViaSftp(async () => sftp as never, '/remote/src', destination, {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(sftp.readdir).toHaveBeenCalledTimes(1))
    controller.abort(new Error('renderer closed'))
    readDirCallback?.(new Error('channel closed'))

    await expect(result).rejects.toThrow('renderer closed')
    expect(sftp.fastGet).not.toHaveBeenCalled()
    expect(sftp.end).toHaveBeenCalledTimes(1)
  })
})
