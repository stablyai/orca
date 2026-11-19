import type { SFTPWrapper, Stats } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import type { SshFileTransferHost } from './file-transfer/ssh-connection-file-transfers'
import { createTarget } from './connection/testing/ssh-connection-test-fixtures'

import { readSshFileChunk } from './ssh-remote-file-read'

function createHost(sftp: SFTPWrapper, usesSystemSshTransport = false): SshFileTransferHost {
  return {
    target: createTarget(),
    usesSystemSshTransport: () => usesSystemSshTransport,
    systemOperationSignal: () => new AbortController().signal,
    systemSshBuildArgsOptions: () => ({}),
    sftp: async () => sftp
  }
}

function createSftpMock(): SFTPWrapper {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test double implements every SFTP method used by the reader.
  const sftp = {
    stat: vi.fn<SFTPWrapper['stat']>(),
    open: vi.fn<SFTPWrapper['open']>(),
    read: vi.fn<SFTPWrapper['read']>(),
    close: vi.fn<SFTPWrapper['close']>(),
    end: vi.fn()
  } as unknown as SFTPWrapper
  vi.mocked(sftp.stat).mockImplementation((_path, callback) =>
    callback(undefined, createStats(11, 12, false))
  )
  vi.mocked(sftp.open).mockImplementation((_path, _flags, callback) =>
    callback(undefined, Buffer.from('handle'))
  )
  vi.mocked(sftp.read).mockImplementation(
    (_handle, buffer, _offset, length, position, callback) => {
      const content = Buffer.from('hello world').subarray(position, position + length)
      content.copy(buffer)
      callback(undefined, content.length, buffer, position)
    }
  )
  vi.mocked(sftp.close).mockImplementation((_handle, callback) => callback(undefined))
  return sftp
}

describe('readSshFileChunk', () => {
  it('reads an SFTP range and reports metadata and EOF', async () => {
    const sftp = createSftpMock()

    await expect(readSshFileChunk(createHost(sftp), '/remote/file.txt', 6, 5)).resolves.toEqual({
      contentBase64: Buffer.from('world').toString('base64'),
      bytesRead: 5,
      eof: true,
      size: 11,
      mtime: 12_000
    })
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('rejects directories before opening them', async () => {
    const sftp = createSftpMock()
    vi.mocked(sftp.stat).mockImplementationOnce((_path, callback) =>
      callback(undefined, createStats(0, 0, true))
    )

    await expect(readSshFileChunk(createHost(sftp), '/remote/folder', 0, 10)).rejects.toThrow(
      'Remote path is a directory'
    )
    expect(sftp.open).not.toHaveBeenCalled()
  })
})

function createStats(size: number, mtime: number, directory: boolean): Stats {
  return {
    mode: 0,
    uid: 0,
    gid: 0,
    size,
    atime: mtime,
    mtime,
    isDirectory: () => directory,
    isFile: () => !directory,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false
  }
}
