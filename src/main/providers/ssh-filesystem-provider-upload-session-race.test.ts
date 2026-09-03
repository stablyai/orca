import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'

function createMux(): { onNotification: ReturnType<typeof vi.fn> } {
  return { onNotification: vi.fn(() => () => {}) }
}

describe('SshFilesystemProvider openFileUploadSession sftp-error race', () => {
  it('closes the retained session when the sftp channel emits a genuine error mid-upload', async () => {
    // Why: a write() that never calls back keeps uploadFile's operation promise
    // pending, so the channel-level error is guaranteed to win the internal race.
    const createWriteStream = vi.fn(() => new Writable({ write() {} }))
    const sftp = Object.assign(new PassThrough(), { createWriteStream, end: vi.fn() })
    const createSftp = vi.fn().mockResolvedValue(sftp)
    const provider = new SshFilesystemProvider('conn-1', createMux() as never, createSftp as never)
    const dir = mkdtempSync(join(tmpdir(), 'orca-sftp-upload-session-error-'))
    const filePath = join(dir, 'payload.txt')
    writeFileSync(filePath, 'payload')

    try {
      const session = await provider.openFileUploadSession()
      const pending = session.uploadFile(filePath, '/remote/payload.txt', {})
      sftp.emit('error', new Error('simulated channel error'))

      await expect(pending).rejects.toThrow('simulated channel error')
      expect(sftp.end).toHaveBeenCalledTimes(1)

      session.close()
      expect(sftp.end).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the retained session open when a local operation fails without a channel error', async () => {
    const createWriteStream = vi.fn(() => {
      const stream = new PassThrough()
      stream.resume()
      return stream
    })
    const sftp = Object.assign(new PassThrough(), { createWriteStream, end: vi.fn() })
    const createSftp = vi.fn().mockResolvedValue(sftp)
    const provider = new SshFilesystemProvider('conn-1', createMux() as never, createSftp as never)
    const dir = mkdtempSync(join(tmpdir(), 'orca-sftp-upload-session-local-fail-'))
    const targetPath = join(dir, process.platform === 'win32' ? 'target-dir' : 'target.txt')
    const linkPath = join(dir, process.platform === 'win32' ? 'link-dir' : 'link.txt')
    if (process.platform === 'win32') {
      mkdirSync(targetPath)
      // Why: file symlinks often require Developer Mode/admin on Windows, while
      // junctions still exercise the symlink rejection branch.
      symlinkSync(targetPath, linkPath, 'junction')
    } else {
      writeFileSync(targetPath, 'secret')
      symlinkSync(targetPath, linkPath)
    }

    try {
      const session = await provider.openFileUploadSession()

      // Why: opening a symlink source fails locally (O_NOFOLLOW/lstat) before
      // createWriteStream() is ever called, so this is a genuine local-only
      // failure with no sftp channel error involved.
      await expect(session.uploadFile(linkPath, '/remote/link.txt', {})).rejects.toThrow()
      expect(sftp.end).not.toHaveBeenCalled()
      expect(createWriteStream).not.toHaveBeenCalled()

      session.close()
      expect(sftp.end).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
