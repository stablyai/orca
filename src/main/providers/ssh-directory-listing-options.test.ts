import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { readSshDirectoryBounded, readSshDirectoryWithSftpFallback } from './ssh-directory-listing'
import { withSftpDirectoryHandles } from './sftp-directory-test-fixture'
import { readSftpDirectory } from './ssh-sftp-directory-listing'
import { readRelayDirectoryBounded } from '../../relay/fs-directory-listing'
import { listSshFiles } from './ssh-file-listing'

function muxFixture() {
  const mock = {
    request: vi.fn().mockResolvedValue([]),
    notify: vi.fn(),
    isDisposed: () => false,
    onDispose: () => () => {},
    onNotificationByMethod: () => () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These are the stream reader's only multiplexer operations.
  return { mock, mux: mock as unknown as SshChannelMultiplexer }
}
function sftpFixture() {
  const mock = {
    readdir: vi.fn((_path, cb) =>
      cb(null, [
        { filename: 'linked', attrs: { isSymbolicLink: () => true, isDirectory: () => false } }
      ])
    ),
    stat: vi.fn((_path, cb) => cb(null, { isDirectory: () => true })),
    end: vi.fn()
  }
  return { mock, sftp: withSftpDirectoryHandles(mock) }
}

describe('integrated bounded inventory options', () => {
  it('forwards both listing preferences without serializing cancellation signals', async () => {
    const { mux, mock } = muxFixture()
    const signal = new AbortController().signal
    await listSshFiles(mux, '/root', { includeIgnored: false, followSymlinks: true, signal })
    expect(mock.request).toHaveBeenCalledWith(
      'fs.listFiles',
      { rootPath: '/root', includeIgnored: false, followSymlinks: true, __streamResponse: true },
      { signal, timeoutMs: undefined }
    )
    await readSshDirectoryBounded(mux, '/root', undefined, { followSymlinks: false })
    expect(mock.request).toHaveBeenLastCalledWith('fs.readDirBounded', {
      dirPath: '/root',
      followSymlinks: false,
      __streamResponse: true
    })
  })
  it('preserves the symlink preference on a legacy relay without SFTP', async () => {
    const { mux, mock } = muxFixture()
    mock.request.mockRejectedValueOnce(
      Object.assign(new Error('Method not found'), { code: -32601 })
    )
    await readSshDirectoryBounded(mux, '/root', undefined, { followSymlinks: false })
    expect(mock.request).toHaveBeenLastCalledWith('fs.readDir', {
      dirPath: '/root',
      followSymlinks: false,
      __streamResponse: true
    })
  })
  it('does not probe link targets on either SFTP route when disabled', async () => {
    const { sftp, mock } = sftpFixture()
    expect(await readSftpDirectory(sftp, '/root', { followSymlinks: false })).toEqual([
      { name: 'linked', isDirectory: false, isSymlink: true }
    ])
    expect(mock.stat).not.toHaveBeenCalled()
    const { mux, mock: transport } = muxFixture()
    transport.request.mockRejectedValue(
      Object.assign(new Error('Method not found'), { code: -32601 })
    )
    const fallback = sftpFixture()
    expect(
      await readSshDirectoryWithSftpFallback(mux, '/root', async () => fallback.sftp, {
        followSymlinks: true
      })
    ).toEqual([{ name: 'linked', isDirectory: true, isSymlink: true }])
    expect(fallback.mock.stat).toHaveBeenCalledTimes(1)
    expect(fallback.mock.end).toHaveBeenCalledTimes(1)
  })
  it('preserves complete relay directory classification with opt-in links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-integrated-dir-'))
    try {
      await mkdir(join(root, 'target'))
      await symlink(join(root, 'target'), join(root, 'linked'), 'dir')
      expect(
        (await readRelayDirectoryBounded(root, undefined, { followSymlinks: false })).find(
          (entry) => entry.name === 'linked'
        )?.isDirectory
      ).toBe(false)
      expect(
        (await readRelayDirectoryBounded(root, undefined, { followSymlinks: true })).find(
          (entry) => entry.name === 'linked'
        )?.isDirectory
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
