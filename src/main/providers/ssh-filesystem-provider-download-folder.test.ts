import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SshFilesystemProvider } from './ssh-filesystem-provider'

type SftpEntryKind = 'directory' | 'file' | 'symlink'

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
    isFIFO: () => false,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false
  }
}

function sftpEntry(filename: string, kind: SftpEntryKind) {
  return { filename, longname: filename, attrs: sftpStats(kind) }
}

function createMockMux() {
  return {
    request: vi.fn(),
    onNotification: vi.fn(() => () => {})
  }
}

describe('SshFilesystemProvider downloadFolder', () => {
  let mux: ReturnType<typeof createMockMux>
  let provider: SshFilesystemProvider
  const localDownloadRoots: string[] = []

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshFilesystemProvider('conn-1', mux as never)
  })

  afterEach(async () => {
    await Promise.all(
      localDownloadRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    )
  })

  it('omits folder capability without SFTP while retaining raw file download', async () => {
    const downloadFile = vi.fn().mockResolvedValue(undefined)
    provider = new SshFilesystemProvider('conn-1', mux as never, undefined, { downloadFile })

    expect(provider.downloadFolder).toBeUndefined()
    await provider.downloadFile('/remote/report.pdf', '/downloads/report.pdf')
    expect(downloadFile).toHaveBeenCalledWith('/remote/report.pdf', '/downloads/report.pdf')
  })

  it('downloads a recursive tree through one SFTP session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-download-'))
    localDownloadRoots.push(root)
    const sftp = {
      stat: vi.fn(
        (remotePath: string, callback: (err: Error | undefined, value: unknown) => void) =>
          callback(undefined, sftpStats(remotePath === '/remote/src' ? 'directory' : 'file'))
      ),
      readdir: vi.fn(
        (remotePath: string, callback: (err: Error | undefined, value: unknown) => void) =>
          callback(
            undefined,
            remotePath === '/remote/src'
              ? [sftpEntry('index.ts', 'file'), sftpEntry('lib', 'directory')]
              : [sftpEntry('a.ts', 'file')]
          )
      ),
      fastGet: vi.fn((_source: string, _destination: string, callback: (err?: Error) => void) =>
        callback()
      ),
      end: vi.fn()
    }
    const createSftp = vi.fn(async () => sftp as never)
    provider = new SshFilesystemProvider('conn-1', mux as never, createSftp)
    const destination = join(root, 'src')

    await provider.downloadFolder!('/remote/src', destination)

    expect(createSftp).toHaveBeenCalledTimes(1)
    expect(sftp.fastGet.mock.calls.map(([source, local]) => [source, local])).toEqual([
      ['/remote/src/index.ts', join(destination, 'index.ts')],
      ['/remote/src/lib/a.ts', join(destination, 'lib', 'a.ts')]
    ])
    await expect(stat(join(destination, 'lib'))).resolves.toMatchObject({})
    expect(sftp.end).toHaveBeenCalledTimes(1)
    expect(mux.request).not.toHaveBeenCalled()
  })

  it('rejects directory symlinks without following them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-download-'))
    localDownloadRoots.push(root)
    const sftp = {
      stat: vi.fn(
        (remotePath: string, callback: (err: Error | undefined, value: unknown) => void) =>
          callback(undefined, sftpStats(remotePath === '/remote/src' ? 'directory' : 'directory'))
      ),
      readdir: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, [sftpEntry('linked-dir', 'symlink')])
      ),
      fastGet: vi.fn(),
      end: vi.fn()
    }
    provider = new SshFilesystemProvider('conn-1', mux as never, async () => sftp as never)

    await expect(provider.downloadFolder!('/remote/src', join(root, 'src'))).rejects.toThrow(
      "Cannot download symbolic link 'linked-dir'"
    )

    expect(sftp.fastGet).not.toHaveBeenCalled()
    expect(sftp.end).toHaveBeenCalledTimes(1)
  })

  it('rejects remote names that sanitize to the same local filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-download-'))
    localDownloadRoots.push(root)
    const sftp = {
      stat: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, sftpStats('directory'))
      ),
      readdir: vi.fn((_path: string, callback: (err: Error | undefined, value: unknown) => void) =>
        callback(undefined, [sftpEntry('a:b.txt', 'file'), sftpEntry('a?b.txt', 'file')])
      ),
      fastGet: vi.fn(),
      end: vi.fn()
    }
    provider = new SshFilesystemProvider('conn-1', mux as never, async () => sftp as never)

    await expect(provider.downloadFolder!('/remote/src', join(root, 'src'))).rejects.toThrow(
      "Remote entries map to the same local name 'a_b.txt'"
    )

    expect(sftp.fastGet).not.toHaveBeenCalled()
    expect(sftp.end).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending SFTP session open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-folder-download-'))
    localDownloadRoots.push(root)
    const createSftp = vi.fn(
      async (options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('open canceled')), {
            once: true
          })
        })
    )
    provider = new SshFilesystemProvider('conn-1', mux as never, createSftp)
    const controller = new AbortController()

    const result = provider.downloadFolder!('/remote/src', join(root, 'src'), {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(createSftp).toHaveBeenCalledTimes(1))
    controller.abort(new Error('renderer closed'))

    await expect(result).rejects.toThrow('open canceled')
    expect(createSftp).toHaveBeenCalledWith({ signal: controller.signal })
    expect(mux.request).not.toHaveBeenCalled()
  })
})
