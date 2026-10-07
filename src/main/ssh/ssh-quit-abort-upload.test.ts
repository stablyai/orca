import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import type { SshTarget } from '../../shared/ssh-types'
import { uploadSshDirectory } from './ssh-connection-file-transfers'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

/** An SFTP session whose writes are accepted but still flushing when the app quits. */
function flushingSftp(): SFTPWrapper {
  const sftp = Object.assign(new EventEmitter(), {
    mkdir: (_path: string, cb: (err?: Error | null) => void) => cb(null),
    createWriteStream: () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
        final() {}
      }),
    end: () => sftp.emit('close')
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the upload calls only these members.
  return sftp as unknown as SFTPWrapper
}

describe('quitting during an orcad bundle upload', () => {
  it("aborts through the connection's teardown signal with no uncaught exception", async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'orca-quit-upload-'))
    // The disconnect aborts this controller, exactly as SshConnection.disconnect does.
    const teardown = new AbortController()
    const uncaught = vi.fn()
    process.prependListener('uncaughtException', uncaught)
    try {
      await writeFile(join(localDir, 'orcad.js'), Buffer.alloc(64 * 1024, 7))
      const upload = uploadSshDirectory(
        {
          target,
          usesSystemSshTransport: () => false,
          systemOperationSignal: () => teardown.signal,
          systemSshBuildArgsOptions: () => ({}),
          sftp: async () => flushingSftp()
        },
        localDir,
        '/home/u/.orca-remote/orcad-candidate'
      )
      const settled = upload.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.name : 'rejected')
      )
      await new Promise((resolve) => setTimeout(resolve, 50))

      teardown.abort()
      await expect(settled).resolves.toBe('AbortError')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(uncaught).not.toHaveBeenCalled()
    } finally {
      process.off('uncaughtException', uncaught)
      await rm(localDir, { recursive: true, force: true })
    }
  })
})
