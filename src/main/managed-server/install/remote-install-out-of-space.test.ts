import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteInstallTransport } from './remote-install-transport'
import { uploadRemoteInstallDirectory, writeRemoteInstallFile } from './remote-install-transfers'
import {
  RemoteInstallOutOfSpaceError,
  remoteFreeSpaceProbeCommand
} from './remote-install-out-of-space'
import { dfAvailableKb } from '../host-state/remote-filesystem-space'
import { execHostCommand } from '../../ssh/remote-exec/remote-host-exec'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

vi.mock('../../ssh/remote-exec/remote-host-exec', () => ({
  execHostCommand: vi.fn()
}))

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
// OpenSSH collapses ENOSPC into SSH_FX_FAILURE without errno.
const sftpFailure = (): Error => Object.assign(new Error('Failure'), { code: 4 })
const dfLine = (availableKb: number): string =>
  `tmpfs 409600 ${409600 - availableKb} ${availableKb} 100% /root\n`

function connection(failure: () => Error): RemoteInstallTransport {
  return {
    exec: vi.fn(),
    usesSystemSshTransport: () => false,
    getConnectGeneration: () => 1,
    uploadDirectory: vi.fn(async () => {
      throw failure()
    }),
    writeFile: vi.fn(async () => {
      throw failure()
    })
  }
}

let localDir = ''
beforeEach(() => {
  localDir = mkdtempSync(join(tmpdir(), 'orca-out-of-space-'))
  writeFileSync(join(localDir, 'orcad.js'), Buffer.alloc(2 * 1024 * 1024))
  vi.mocked(execHostCommand).mockReset()
})
afterEach(() => rmSync(localDir, { recursive: true, force: true }))

describe('a failed install write on a full host', () => {
  it('says the disk is full instead of the bare SFTP "Failure"', async () => {
    vi.mocked(execHostCommand).mockResolvedValue(dfLine(12))
    const upload = uploadRemoteInstallDirectory(
      connection(sftpFailure),
      localDir,
      '/root/.orca-remote/orcad-0.1.0+abc',
      posix
    )
    await expect(upload).rejects.toBeInstanceOf(RemoteInstallOutOfSpaceError)
    await expect(upload).rejects.toThrow(
      /out of disk space: the filesystem holding \/root\/\.orca-remote\/orcad-0\.1\.0\+abc has 12 KB free, and Orca needs about 2\.0 MB/
    )
    expect(vi.mocked(execHostCommand).mock.calls[0]?.[2]).toBe(
      remoteFreeSpaceProbeCommand('/root/.orca-remote/orcad-0.1.0+abc')
    )
  })

  it('sizes a single file write by its contents', async () => {
    vi.mocked(execHostCommand).mockResolvedValue(dfLine(0))
    await expect(
      writeRemoteInstallFile(connection(sftpFailure), posix, '/root/.orca-remote/x/.version', 'abc')
    ).rejects.toThrow(/has 0 KB free, and Orca needs about 1 KB/)
  })

  it('keeps the original error when the filesystem still has room', async () => {
    // Partial uploads may have consumed space; less than the bundle size does not prove exhaustion.
    vi.mocked(execHostCommand).mockResolvedValue(dfLine(1_500))
    const failure = sftpFailure()
    await expect(
      uploadRemoteInstallDirectory(
        connection(() => failure),
        localDir,
        '/root/r',
        posix
      )
    ).rejects.toBe(failure)
  })

  it('keeps the original error when the space probe itself fails', async () => {
    vi.mocked(execHostCommand).mockRejectedValue(new Error('df: not found'))
    const failure = sftpFailure()
    await expect(
      uploadRemoteInstallDirectory(
        connection(() => failure),
        localDir,
        '/root/r',
        posix
      )
    ).rejects.toBe(failure)
  })

  it('keeps explicit refusals such as permission denied without probing', async () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 3 })
    await expect(
      uploadRemoteInstallDirectory(
        connection(() => denied),
        localDir,
        '/root/r',
        posix
      )
    ).rejects.toBe(denied)
    expect(execHostCommand).not.toHaveBeenCalled()
  })

  it('never probes after unverifiable transport loss, an abort, or on Windows', async () => {
    const lost = Object.assign(new Error('SSH command timed out'), {
      code: 4,
      sshChannelCloseConfirmed: false
    })
    await expect(
      uploadRemoteInstallDirectory(
        connection(() => lost),
        localDir,
        '/root/r',
        posix
      )
    ).rejects.toBe(lost)
    const controller = new AbortController()
    controller.abort()
    await expect(
      uploadRemoteInstallDirectory(connection(sftpFailure), localDir, '/root/r', posix, {
        signal: controller.signal
      })
    ).rejects.toThrow()
    const failure = sftpFailure()
    await expect(
      uploadRemoteInstallDirectory(
        connection(() => failure),
        localDir,
        'C:/Users/u/r',
        windows
      )
    ).rejects.toBe(failure)
    expect(execHostCommand).not.toHaveBeenCalled()
  })
})

describe('remoteFreeSpaceProbeCommand', () => {
  it.skipIf(process.platform === 'win32')(
    'reads free space from the nearest existing directory through a real /bin/sh',
    () => {
      const missing = join(localDir, "not yet's made", 'stage dir')
      const out = execFileSync('/bin/sh', ['-c', remoteFreeSpaceProbeCommand(missing)], {
        encoding: 'utf8'
      })
      expect(dfAvailableKb(out.trim())).toEqual(expect.any(Number))
    }
  )
})
