import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uploadBuffer, uploadFile, writeStringViaSftp, writeStringsViaSftp } from './sftp-upload'
import { writeRelayFile } from './ssh-relay-install-transfers'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

/** The exact error ssh2 builds from a STATUS reply of SSH_FX_NO_SUCH_FILE. */
function sftpNoSuchFileError(): Error {
  return Object.assign(new Error('file does not exist'), { code: 2 })
}

let tempDir = ''
let localFile = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orca-sftp-late-'))
  localFile = join(tempDir, 'relay.js')
  await writeFile(localFile, 'console.log(1)\n')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function sftpDoubleReturning(stream: PassThrough): SFTPWrapper {
  return Object.assign(new EventEmitter(), {
    createWriteStream: () => stream
  }) as unknown as SFTPWrapper
}

describe('late SFTP stream errors', () => {
  // ssh2 emits the OPEN failure from inside the protocol parser. If no listener is left,
  // Node throws it synchronously up through Socket.emit('data') and the main process dies
  // (#15479) — uncaught exceptions are re-thrown by installUncaughtPipeErrorGuard, unlike
  // rejections, which are only logged.
  it('does not throw when a write stream fails after uploadFile settles', async () => {
    const stream = new PassThrough()
    stream.resume()

    await uploadFile(sftpDoubleReturning(stream), localFile, '/home/user/.orca-remote/relay.js')

    expect(() => stream.emit('error', sftpNoSuchFileError())).not.toThrow()
  })

  it('does not throw when a write stream fails after writeStringViaSftp settles', async () => {
    const stream = new PassThrough()
    stream.resume()

    await writeStringViaSftp(sftpDoubleReturning(stream), '/home/user/.orca-remote/.version', 'v1')

    expect(() => stream.emit('error', sftpNoSuchFileError())).not.toThrow()
  })

  it('does not throw when a write stream fails after uploadBuffer settles', async () => {
    const stream = new PassThrough()
    stream.resume()

    await uploadBuffer(sftpDoubleReturning(stream), Buffer.from('x'), '/home/user/x')

    expect(() => stream.emit('error', sftpNoSuchFileError())).not.toThrow()
  })

  // The failure mode a per-file loop reintroduces: writeStringViaSftp removes its own
  // session listener at each settle, so a session that ran N transfers ends up with zero
  // listeners while it is still open and still able to deliver a STATUS reply.
  it('does not throw when a session error arrives after a multi-file write settles', async () => {
    const sftp = Object.assign(new EventEmitter(), {
      createWriteStream: () => {
        const stream = new PassThrough()
        stream.resume()
        return stream
      },
      end: () => {}
    }) as unknown as SFTPWrapper

    await writeStringsViaSftp({ sftp: () => Promise.resolve(sftp) }, [
      { path: '/home/user/.local/bin/orca', contents: '#!/bin/sh\n' },
      { path: '/home/user/.local/bin/orca.mjs', contents: 'export {}\n' }
    ])

    expect(() => sftp.emit('error', sftpNoSuchFileError())).not.toThrow()
  })

  it('still rejects a multi-file write with a session error raised during it', async () => {
    const sftp = Object.assign(new EventEmitter(), {
      createWriteStream: () => {
        const stream = new PassThrough()
        queueMicrotask(() => sftp.emit('error', sftpNoSuchFileError()))
        return stream
      },
      end: () => {}
    }) as unknown as SFTPWrapper

    // The latch must sit behind the transfer's own prepended listener, or a real
    // mid-transfer failure would be swallowed into a hang.
    await expect(
      writeStringsViaSftp({ sftp: () => Promise.resolve(sftp) }, [
        { path: '/home/user/.local/bin/orca', contents: '#!/bin/sh\n' }
      ])
    ).rejects.toThrow('file does not exist')
  })

  it('still rejects with the SFTP error when it arrives during the transfer', async () => {
    const stream = new PassThrough()
    stream.resume()
    const failing = Object.assign(new EventEmitter(), {
      createWriteStream: () => {
        queueMicrotask(() => stream.emit('error', sftpNoSuchFileError()))
        return stream
      }
    }) as unknown as SFTPWrapper

    await expect(writeStringViaSftp(failing, '/home/user/x', 'v1')).rejects.toThrow(
      'file does not exist'
    )
  })
})

describe('sandboxed SFTP subsystem diagnosis', () => {
  it('leaves a permission refusal as itself rather than blaming a chroot', async () => {
    // SSH_FX_PERMISSION_DENIED is a mode/ownership refusal on a path the subsystem can
    // see -- a read-only home, a root-owned parent, a quota. Rewriting it into "your
    // bastion chroots SFTP" sends the user to fix ProxyJump for a chmod.
    const conn = {
      writeFile: () => Promise.reject(Object.assign(new Error('permission denied'), { code: 3 }))
    } as unknown as SshConnection

    const failure: unknown = await writeRelayFile(
      conn,
      getRemoteHostPlatform('linux-x64'),
      '/home/user/.orca-remote/relay-1/.version',
      'v1'
    ).then(
      () => null,
      (err: unknown) => err
    )

    expect((failure as Error).message).toBe('permission denied')
    expect(failure).not.toHaveProperty('sandboxedSftpNamespace')
  })

  it('replaces the bare SFTP status with an actionable relay-install message', async () => {
    const conn = {
      writeFile: () => Promise.reject(sftpNoSuchFileError())
    } as unknown as SshConnection

    await expect(
      writeRelayFile(
        conn,
        getRemoteHostPlatform('linux-x64'),
        '/home/user/.orca-remote/relay-1/.version',
        'v1'
      )
    ).rejects.toThrow(/SFTP subsystem sees a different filesystem/)
  })

  it('leaves unrelated transfer failures untouched', async () => {
    const conn = {
      writeFile: () => Promise.reject(new Error('Connection lost'))
    } as unknown as SshConnection

    await expect(
      writeRelayFile(conn, getRemoteHostPlatform('linux-x64'), '/home/user/x', 'v1')
    ).rejects.toThrow('Connection lost')
  })
})
