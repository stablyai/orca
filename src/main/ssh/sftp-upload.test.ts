import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Writable } from 'stream'
import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { uploadBuffer, uploadDirectory, uploadFile } from './sftp-upload'

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
    createWriteStream: vi.fn(() => createWritable())
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
      flags: 'wx'
    })
  })

  it('does not create the remote file when the local source is a symlink', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'orca-sftp-upload-'))
    await writeFile(join(localDir, 'target.txt'), 'secret')
    await symlink(join(localDir, 'target.txt'), join(localDir, 'link.txt'))
    const sftp = createSftpMock()

    await expect(uploadFile(sftp, join(localDir, 'link.txt'), '/remote/link.txt')).rejects.toThrow()

    expect(sftp.createWriteStream).not.toHaveBeenCalled()
  })
})
