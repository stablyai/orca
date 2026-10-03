import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { openSshFileUploadSession } from './ssh-filesystem-file-upload'

function asSftp(fake: object): SFTPWrapper {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements only the calls the session makes.
  return fake as SFTPWrapper
}

describe('SSH file upload session rollback', () => {
  it('removes created entries on the same SFTP channel, never recursively', async () => {
    const sftp = {
      unlink: vi.fn((_path: string, done: (error?: Error | null) => void) => done(null)),
      rmdir: vi.fn((_path: string, done: (error?: Error | null) => void) => done(null)),
      end: vi.fn()
    }
    const createSftp = vi.fn(async () => asSftp(sftp))
    const session = await openSshFileUploadSession(createSftp)

    await session.removeCreatedEntry?.('/r/src/a', 'file')
    await session.removeCreatedEntry?.('/r/src', 'directory')

    expect(createSftp).toHaveBeenCalledTimes(1)
    expect(sftp.unlink).toHaveBeenCalledWith('/r/src/a', expect.any(Function))
    expect(sftp.rmdir).toHaveBeenCalledWith('/r/src', expect.any(Function))
    expect(sftp.end).not.toHaveBeenCalled()
  })

  it('surfaces a removal the server refuses, so the ledger can report the leftover', async () => {
    const sftp = {
      rmdir: vi.fn((_path: string, done: (error?: Error | null) => void) =>
        done(new Error('Failure: directory not empty'))
      ),
      end: vi.fn()
    }
    const session = await openSshFileUploadSession(async () => asSftp(sftp))

    await expect(session.removeCreatedEntry?.('/r/src', 'directory')).rejects.toThrow(
      'directory not empty'
    )
  })
})
