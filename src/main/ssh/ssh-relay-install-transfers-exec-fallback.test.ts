import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { createSshOperationAbortError } from './ssh-connection-utils'
import {
  uploadDirectoryViaExecStdin,
  writeStringViaExecStdin
} from './ssh-exec-stdin-file-transfer'
import {
  classifySftpFailureForExecFallback,
  uploadRelayDirectory,
  writeRelayFile
} from './ssh-relay-install-transfers'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('./ssh-exec-stdin-file-transfer', () => ({
  uploadDirectoryViaExecStdin: vi.fn(async () => {}),
  writeStringViaExecStdin: vi.fn(async () => {})
}))

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const subsystemRefused = (): Error => new Error('Unable to start subsystem: sftp')
const sandboxed = (): Error => Object.assign(new Error('No such file'), { code: 2 })
const unconfirmed = (): Error =>
  Object.assign(new Error('SSH command timed out'), { sshChannelCloseConfirmed: false })

function connection(
  failure: () => Error,
  overrides: Partial<Record<'usesSystemSshTransport' | 'getConnectGeneration', () => unknown>> = {}
): SshConnection & {
  uploadDirectory: ReturnType<typeof vi.fn>
  writeFile: ReturnType<typeof vi.fn>
} {
  const conn = {
    uploadDirectory: vi.fn(async () => {
      throw failure()
    }),
    writeFile: vi.fn(async () => {
      throw failure()
    }),
    usesSystemSshTransport: () => false,
    getConnectGeneration: () => 1,
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transfers only use the members defined above.
  return conn as unknown as SshConnection & {
    uploadDirectory: ReturnType<typeof vi.fn>
    writeFile: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  vi.mocked(uploadDirectoryViaExecStdin).mockClear()
  vi.mocked(writeStringViaExecStdin).mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('classifySftpFailureForExecFallback', () => {
  it('accepts only the host refusing or sandboxing SFTP', () => {
    expect(classifySftpFailureForExecFallback(subsystemRefused())).toBe('sftp-unavailable')
    expect(
      classifySftpFailureForExecFallback(
        new Error('Received exit code 127 while establishing SFTP session')
      )
    ).toBe('sftp-unavailable')
    expect(classifySftpFailureForExecFallback(sandboxed())).toBe('sftp-sandboxed')
  })

  it('never treats unverifiable transport loss or a refusal of the write itself as a verdict', () => {
    for (const error of [
      unconfirmed(),
      Object.assign(subsystemRefused(), { sshChannelCloseConfirmed: false }),
      new Error('Received unexpected SFTP session termination'),
      new Error('SSH SFTP channel timed out'),
      new Error('Not connected'),
      createSshOperationAbortError(),
      Object.assign(new Error('Permission denied'), { code: 3 }),
      'Unable to start subsystem: sftp'
    ]) {
      expect(classifySftpFailureForExecFallback(error)).toBeNull()
    }
  })
})

describe('relay install transfer fallback selection', () => {
  it('streams over exec stdin when the subsystem is refused, and skips SFTP for the rest of the connect', async () => {
    const conn = connection(subsystemRefused)
    await uploadRelayDirectory(conn, '/local/relay', '/h/.orca-remote/stage/payload', posix)
    await writeRelayFile(conn, posix, '/h/.orca-remote/stage/payload/.version', '0.1.0+abc')

    expect(uploadDirectoryViaExecStdin).toHaveBeenCalledWith(
      conn,
      '/local/relay',
      '/h/.orca-remote/stage/payload',
      posix,
      { signal: undefined }
    )
    expect(writeStringViaExecStdin).toHaveBeenCalledWith(
      conn,
      '/h/.orca-remote/stage/payload/.version',
      '0.1.0+abc',
      { signal: undefined }
    )
    expect(conn.writeFile).not.toHaveBeenCalled()
  })

  it('asks SFTP again after a reconnect', async () => {
    let generation = 1
    const conn = connection(subsystemRefused, { getConnectGeneration: () => generation })
    await uploadRelayDirectory(conn, '/l', '/h/r', posix)
    generation = 2
    await uploadRelayDirectory(conn, '/l', '/h/r', posix)
    expect(conn.uploadDirectory).toHaveBeenCalledTimes(2)
  })

  it('falls back for a chrooted subsystem without remembering it as a host verdict', async () => {
    const conn = connection(sandboxed)
    await uploadRelayDirectory(conn, '/l', '/h/r', posix)
    await uploadRelayDirectory(conn, '/l', '/h/r', posix)
    expect(conn.uploadDirectory).toHaveBeenCalledTimes(2)
    expect(uploadDirectoryViaExecStdin).toHaveBeenCalledTimes(2)
  })

  it('surfaces unverifiable transport loss instead of retrying down another path', async () => {
    const lost = unconfirmed()
    const conn = connection(() => lost)
    await expect(uploadRelayDirectory(conn, '/l', '/h/r', posix)).rejects.toBe(lost)
    expect(uploadDirectoryViaExecStdin).not.toHaveBeenCalled()
  })

  it('does not fall back when the caller aborted', async () => {
    const controller = new AbortController()
    const conn = connection(() => {
      controller.abort()
      return subsystemRefused()
    })
    await expect(
      uploadRelayDirectory(conn, '/l', '/h/r', posix, { signal: controller.signal })
    ).rejects.toThrow()
    expect(uploadDirectoryViaExecStdin).not.toHaveBeenCalled()
  })

  it('keeps the sandbox diagnosis where exec stdin cannot apply', async () => {
    await expect(
      uploadRelayDirectory(connection(sandboxed), '/l', 'C:/Users/u/r', windows)
    ).rejects.toThrow(/SFTP subsystem sees a different filesystem/)
    await expect(
      uploadRelayDirectory(
        connection(sandboxed, { usesSystemSshTransport: () => true }),
        '/l',
        '/h/r',
        posix
      )
    ).rejects.toThrow(/SFTP subsystem sees a different filesystem/)
    expect(uploadDirectoryViaExecStdin).not.toHaveBeenCalled()
  })
})
