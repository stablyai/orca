import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uploadBuffer, uploadFile, writeStringViaSftp } from './sftp-upload'
import { writeRemoteInstallFile } from '../managed-server/install/remote-install-transfers'
import type { SshConnection } from './connection/ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

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
  // Late OPEN errors throw synchronously from ssh2's parser without a surviving listener, killing main (#15479).
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
    // Permission denial names visible paths; mislabeling it as sandboxing sends users to fix ProxyJump for chmod.
    const conn = {
      writeFile: () => Promise.reject(Object.assign(new Error('permission denied'), { code: 3 }))
    } as unknown as SshConnection

    const failure: unknown = await writeRemoteInstallFile(
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

    // Windows hosts have no exec-stdin fallback; POSIX hosts stream instead (exec-fallback tests).
    await expect(
      writeRemoteInstallFile(
        conn,
        getRemoteHostPlatform('win32-x64'),
        'C:/Users/user/.orca-remote/relay-1/.version',
        'v1'
      )
    ).rejects.toThrow(/SFTP subsystem sees a different filesystem/)
  })

  it('leaves unrelated transfer failures untouched', async () => {
    const conn = {
      writeFile: () => Promise.reject(new Error('Connection lost'))
    } as unknown as SshConnection

    await expect(
      writeRemoteInstallFile(conn, getRemoteHostPlatform('linux-x64'), '/home/user/x', 'v1')
    ).rejects.toThrow('Connection lost')
  })
})
