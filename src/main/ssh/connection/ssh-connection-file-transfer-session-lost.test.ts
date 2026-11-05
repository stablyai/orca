import { EventEmitter } from 'node:events'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadSshDirectory, type SshFileTransferHost } from './ssh-connection-file-transfers'

// Model ssh2 session loss: queued requests and write-stream CLOSE never answer, leaving transfers pending.
vi.mock('../sftp-upload', () => ({ uploadDirectory: vi.fn(() => new Promise<void>(() => {})) }))

function hostWith(
  sftp: EventEmitter,
  operation = new AbortController().signal
): SshFileTransferHost {
  return {
    target: { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' },
    usesSystemSshTransport: () => false,
    systemOperationSignal: () => operation,
    systemSshBuildArgsOptions: () => ({}),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transfer only listens to the session and ends it.
    sftp: async () => sftp as unknown as SFTPWrapper
  }
}

function fakeSession(): EventEmitter & { end: () => void; ended: number } {
  return Object.assign(new EventEmitter(), {
    ended: 0,
    end(this: { ended: number }) {
      this.ended += 1
    }
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('an SFTP transfer whose SSH connection dies', () => {
  it('fails as lost contact instead of waiting forever', async () => {
    const sftp = fakeSession()
    const upload = uploadSshDirectory(hostWith(sftp), '/local/runtime', '/root/.orca-remote/x')
    await vi.waitFor(async () => {
      const { uploadDirectory } = await import('../sftp-upload')
      expect(uploadDirectory).toHaveBeenCalled()
    })
    sftp.emit('close')
    await expect(upload).rejects.toMatchObject({
      name: 'SftpSessionClosedError',
      sshChannelCloseConfirmed: false
    })
    expect(sftp.listenerCount('close')).toBe(0)
    // The abandoned transfer is cancelled too, so it stops and closes its local files.
    const { uploadDirectory } = await import('../sftp-upload')
    const transferSignal = vi.mocked(uploadDirectory).mock.calls[0]?.[4]?.signal
    expect(transferSignal?.aborted).toBe(true)
  })

  it('keeps a cancel a cancel when the session closes because Orca ended it', async () => {
    const sftp = fakeSession()
    const cancel = new AbortController()
    const upload = uploadSshDirectory(hostWith(sftp, cancel.signal), '/local/r', '/root/r')
    const { uploadDirectory } = await import('../sftp-upload')
    await vi.waitFor(() => expect(uploadDirectory).toHaveBeenCalled())
    cancel.abort()
    sftp.emit('close')
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('ignores a session close after the transfer finished', async () => {
    const { uploadDirectory } = await import('../sftp-upload')
    vi.mocked(uploadDirectory).mockResolvedValueOnce(undefined)
    const sftp = fakeSession()
    await uploadSshDirectory(hostWith(sftp), '/local/r', '/root/r')
    expect(sftp.ended).toBe(1)
    // The close that ending the session produces is expected, so nothing is left listening.
    sftp.emit('close')
    expect(sftp.listenerCount('close')).toBe(0)
  })
})
