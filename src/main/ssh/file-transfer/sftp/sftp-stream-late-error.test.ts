import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uploadBuffer, writeStringViaSftp } from './sftp-upload'
import { uploadFile } from './sftp-file-upload'

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
