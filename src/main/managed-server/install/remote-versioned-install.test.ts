import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn()
}))

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

vi.mock('../../../shared/shell-argument-quoting', () => ({
  quotePosixShell: (s: string) => `'${s}'`
}))

import { existsSync, readFileSync } from 'node:fs'
import {
  readLocalFullVersion,
  isRemoteInstallComplete,
  finalizeInstall,
  abandonInstall
} from './remote-versioned-install'
import { gcOldRemoteInstallVersions } from './remote-install-gc'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import {
  isUnconfirmedSshCommandTermination,
  execCommand
} from '../../ssh/remote-exec/remote-exec-command'
import { acquireInstallLock } from './remote-install-lock'
import {
  isRelayGcClaimed,
  relayGcClaimPath,
  releaseRelayGcClaim,
  tryAcquireRelayGcClaim,
  waitForRelayGcClaimRelease
} from './remote-install-gc-claim'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import type { SshConnection } from '../../ssh/connection/ssh-connection'

const conn = {} as SshConnection
const mockExec = vi.mocked(execCommand)
const mockExists = vi.mocked(existsSync)
const mockRead = vi.mocked(readFileSync)

function decodePowerShellCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : ''
}

describe('readLocalFullVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns trimmed contents of the .version file', () => {
    mockExists.mockReturnValue(true)
    mockRead.mockReturnValue('0.1.0+deadbeef\n')
    expect(readLocalFullVersion('/local/relay')).toBe('0.1.0+deadbeef')
  })

  it('throws an actionable error when the .version file is missing', () => {
    mockExists.mockReturnValue(false)
    expect(() => readLocalFullVersion('/local/relay')).toThrow(/missing its version marker/)
  })

  it('throws when the .version file is empty', () => {
    mockExists.mockReturnValue(true)
    mockRead.mockReturnValue('   \n')
    expect(() => readLocalFullVersion('/local/relay')).toThrow(/is empty/)
  })
})

describe('isRemoteInstallComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true only when the OK probe succeeds', async () => {
    mockExec.mockResolvedValueOnce('OK')
    expect(await isRemoteInstallComplete(conn, ORCAD_INSTALL_MODEL, '/r')).toBe(true)
  })

  it('returns false when the probe reports MISSING', async () => {
    mockExec.mockResolvedValueOnce('MISSING')
    expect(await isRemoteInstallComplete(conn, ORCAD_INSTALL_MODEL, '/r')).toBe(false)
  })

  it('returns false on exec error', async () => {
    mockExec.mockRejectedValueOnce(new Error('boom'))
    expect(await isRemoteInstallComplete(conn, ORCAD_INSTALL_MODEL, '/r')).toBe(false)
  })

  it('does not convert an aborted install probe into a missing install', async () => {
    const controller = new AbortController()
    mockExec.mockImplementationOnce(async () => {
      controller.abort()
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    })

    await expect(
      isRemoteInstallComplete(conn, ORCAD_INSTALL_MODEL, '/r', undefined, {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps default probe failures as not installed for SSH session-limit-shaped errors', async () => {
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    mockExec.mockRejectedValueOnce(sessionLimitError)

    await expect(isRemoteInstallComplete(conn, ORCAD_INSTALL_MODEL, '/r')).resolves.toBe(false)
  })

  it('rethrows SSH session-limit errors in strict mode', async () => {
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    mockExec.mockRejectedValueOnce(sessionLimitError)

    await expect(
      isRemoteInstallComplete(conn, ORCAD_INSTALL_MODEL, '/r', undefined, {
        rethrowSessionLimitErrors: true
      })
    ).rejects.toBe(sessionLimitError)
  })

  it('remote completeness requires every model artifact and the install sentinel', async () => {
    mockExec.mockResolvedValueOnce('OK')
    const host = getRemoteHostPlatform('linux-x64')
    await isRemoteInstallComplete(conn, ORCAD_INSTALL_MODEL, '/r', host)
    const cmd = mockExec.mock.calls.at(-1)?.[1] ?? ''
    expect(ORCAD_INSTALL_MODEL.requiredArtifacts(host).length).toBeGreaterThan(0)
    expect(cmd).toContain("cd '/r'")
    for (const artifact of ORCAD_INSTALL_MODEL.requiredArtifacts(host)) {
      expect(cmd).toContain(`test -f '${artifact}'`)
    }
    expect(cmd).toContain(ORCAD_INSTALL_MODEL.installCompleteFilename)
  })
})

describe('acquireInstallLock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns when mkdir reports OK', async () => {
    mockExec
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('OPEN')
    await acquireInstallLock(conn, '/r')
    expect(mockExec).toHaveBeenCalledTimes(4)
  })

  it('recovers a stale sibling GC claim before first-install lock acquisition', async () => {
    mockExec
      .mockResolvedValueOnce('LOCKED')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('RELEASED')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('OPEN')

    await expect(acquireInstallLock(conn, '/r')).resolves.toBeUndefined()

    const commands = mockExec.mock.calls.map(([, command]) => command)
    expect(commands[1]).toContain('lock_tombstone')
    expect(commands[4]).toBe("mkdir -p '/r'")
  })

  it('polls until the lock becomes available (concurrent installer wins, then we acquire)', async () => {
    vi.useFakeTimers()
    try {
      let createAttempts = 0
      mockExec.mockImplementation(async (_conn: unknown, command: string) => {
        if (command.includes('.gc-claim')) {
          return 'OPEN'
        }
        if (command.startsWith('mkdir -p')) {
          return ''
        }
        if (command.includes('lock_tombstone')) {
          return 'BUSY'
        }
        if (command.includes('.install-lock')) {
          createAttempts++
          return createAttempts >= 3 ? 'OK' : 'BUSY'
        }
        return ''
      })

      const promise = acquireInstallLock(conn, '/r')
      // Drive the polling loop: each iteration awaits a 1s timer.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1_000)
      }
      await promise
      const cmds = mockExec.mock.calls.map(([, c]) => c)
      const mkdirAttempts = cmds.filter((c) => c.includes('mkdir') && c.includes('.install-lock'))
      expect(mkdirAttempts.length).toBeGreaterThanOrEqual(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('immediately tries to steal an already-stale lock', async () => {
    mockExec
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('BUSY')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('OPEN')

    await expect(acquireInstallLock(conn, '/r')).resolves.toBeUndefined()

    const cmds = mockExec.mock.calls.map(([, c]) => c)
    expect(cmds).toHaveLength(5)
    expect(cmds[3]).toContain('lock_tombstone')
  })

  it('retries stale takeover when a fresh lock ages out during the wait', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    try {
      const recoverableAt = Date.now() + 60_000
      mockExec.mockImplementation(async (_conn: unknown, cmd: string) => {
        if (cmd.includes('.gc-claim')) {
          return 'OPEN'
        }
        if (cmd.startsWith('mkdir -p')) {
          return ''
        }
        if (cmd.includes('lock_tombstone')) {
          return Date.now() >= recoverableAt ? 'OK' : 'BUSY'
        }
        if (cmd.includes('mkdir') && cmd.includes('.install-lock')) {
          return 'BUSY'
        }
        return ''
      })

      const promise = acquireInstallLock(conn, '/r')
      await vi.advanceTimersByTimeAsync(61_000)

      await expect(promise).resolves.toBeUndefined()
      expect(mockExec.mock.calls.filter(([, cmd]) => cmd.includes('lock_tombstone'))).toHaveLength(
        2
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws if the timeout elapses and the lock is fresh', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    try {
      mockExec.mockImplementation(async (_conn: unknown, cmd: string) => {
        if (cmd.includes('.gc-claim')) {
          return 'OPEN'
        }
        if (cmd.startsWith('mkdir -p')) {
          return ''
        }
        if (cmd.includes('lock_tombstone')) {
          return 'BUSY'
        }
        if (cmd.includes('mkdir') && cmd.includes('.install-lock')) {
          return 'BUSY'
        }
        if (cmd.includes('stat')) {
          return '0\n'
        }
        return ''
      })

      const rejection = expect(acquireInstallLock(conn, '/r')).rejects.toThrow(
        /another install is still in progress/i
      )
      await vi.advanceTimersByTimeAsync(905_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling when the caller aborts the lock wait', async () => {
    vi.useFakeTimers()
    try {
      const abortController = new AbortController()
      mockExec.mockImplementation(async (_conn: unknown, cmd: string) =>
        cmd.includes('.gc-claim') ? 'OPEN' : 'BUSY'
      )

      const promise = acquireInstallLock(conn, '/r', undefined, {
        signal: abortController.signal
      })
      await vi.advanceTimersByTimeAsync(1_000)
      abortController.abort()
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })

      const callCountAfterAbort = mockExec.mock.calls.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockExec).toHaveBeenCalledTimes(callCountAfterAbort)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps waiting while a slow first installer is within the deploy bound', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    try {
      const availableAt = Date.now() + 500_000
      mockExec.mockImplementation(async (_conn: unknown, cmd: string) => {
        if (cmd.includes('.gc-claim')) {
          return 'OPEN'
        }
        if (cmd.startsWith('mkdir -p')) {
          return ''
        }
        if (cmd.includes('mkdir') && cmd.includes('.install-lock')) {
          return Date.now() >= availableAt ? 'OK' : 'BUSY'
        }
        return ''
      })

      const promise = acquireInstallLock(conn, '/r')
      await vi.advanceTimersByTimeAsync(501_000)

      await expect(promise).resolves.toBeUndefined()
      expect(
        mockExec.mock.calls.filter(([, cmd]) => cmd.includes('lock_tombstone')).length
      ).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('finalizeInstall writes .install-complete then removes the lock', async () => {
    mockExec.mockResolvedValueOnce('').mockResolvedValueOnce('')
    await finalizeInstall(conn, '/r')
    const cmds = mockExec.mock.calls.map(([, c]) => c)
    expect(cmds[0]).toContain('touch')
    expect(cmds[0]).toContain('.install-complete')
    expect(cmds[1]).toContain('rm -rf')
    expect(cmds[1]).toContain('.install-lock')
  })

  it('abandonInstall removes the lock without writing the sentinel', async () => {
    mockExec.mockResolvedValueOnce('')
    await abandonInstall(conn, '/r')
    const cmd = mockExec.mock.calls[0]?.[1] ?? ''
    expect(cmd).toContain('rm -rf')
    expect(cmd).toContain('.install-lock')
    expect(cmd).not.toContain('.install-complete')
  })
})

describe('relay GC claim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExec.mockReset()
  })

  it('parses explicit claim markers through remote startup noise', async () => {
    mockExec.mockResolvedValueOnce('Welcome to host\nLOCKED\n')
    await expect(isRelayGcClaimed(conn, '/relay/version')).resolves.toBe(true)

    mockExec.mockResolvedValueOnce('Last login: today\nOPEN\n')
    await expect(isRelayGcClaimed(conn, '/relay/version')).resolves.toBe(false)
  })

  it('rejects missing or conflicting claim markers', async () => {
    mockExec.mockResolvedValueOnce('Welcome to host\n')
    await expect(isRelayGcClaimed(conn, '/relay/version')).rejects.toThrow('Inconclusive')

    mockExec.mockResolvedValueOnce('LOCKED\nOPEN\n')
    await expect(isRelayGcClaimed(conn, '/relay/version')).rejects.toThrow('Inconclusive')
  })

  it('uses a stable sibling path outside the recursively deleted install', async () => {
    mockExec.mockResolvedValueOnce('OK').mockResolvedValueOnce('')

    await expect(tryAcquireRelayGcClaim(conn, '/relay/version')).resolves.toEqual(
      expect.any(String)
    )

    expect(relayGcClaimPath('/relay/version')).toBe('/relay/version.gc-claim')
    expect(mockExec.mock.calls[0]?.[1]).toContain("mkdir '/relay/version.gc-claim'")
  })

  it('recovers and removes a stale sibling claim before retrying deploy', async () => {
    mockExec
      .mockResolvedValueOnce('LOCKED')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('RELEASED')

    await waitForRelayGcClaimRelease(conn, '/relay/version')

    const commands = mockExec.mock.calls.map(([, command]) => command)
    expect(commands[1]).toContain('lock_tombstone')
    expect(commands[3]).toContain("rm -rf '/relay/version.gc-claim'")
  })

  it('keeps waiting after losing a recovered claim until the claim is actually gone', async () => {
    mockExec
      .mockResolvedValueOnce('LOCKED')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('LOST')
      .mockResolvedValueOnce('OPEN')

    await waitForRelayGcClaimRelease(conn, '/relay/version')

    expect(mockExec).toHaveBeenCalledTimes(5)
  })

  it('writes and conditionally releases the Windows sibling claim owner token', async () => {
    const windows = getRemoteHostPlatform('win32-x64')
    mockExec.mockResolvedValueOnce('OK').mockResolvedValueOnce('').mockResolvedValueOnce('RELEASED')

    const token = await tryAcquireRelayGcClaim(conn, 'C:/relay/version', windows)
    expect(token).toEqual(expect.any(String))
    await expect(releaseRelayGcClaim(conn, 'C:/relay/version', token!, windows)).resolves.toBe(
      'released'
    )

    const ownerScript = decodePowerShellCommand(mockExec.mock.calls[1]?.[1] ?? '')
    const releaseScript = decodePowerShellCommand(mockExec.mock.calls[2]?.[1] ?? '')
    expect(ownerScript).toContain('Set-Content -LiteralPath')
    expect(ownerScript).toContain('.gc-claim/.gc-owner')
    expect(releaseScript).toContain('Get-Content -LiteralPath')
    expect(releaseScript).toContain('-cne')
    expect(releaseScript).toContain('Remove-Item -LiteralPath')
    expect(releaseScript).toContain("'RELEASED'")
    expect(releaseScript).toContain("'LOST'")
    expect(releaseScript).toContain("'UNKNOWN'")
    expect(releaseScript).not.toContain('}; elseif')
    expect(releaseScript).not.toContain('{;')
  })

  it('conditionally releases a claim when the owner write reply is lost', async () => {
    mockExec
      .mockResolvedValueOnce('OK')
      .mockRejectedValueOnce(new Error('owner write reply lost'))
      .mockResolvedValueOnce('RELEASED')

    await expect(tryAcquireRelayGcClaim(conn, '/relay/version')).resolves.toBeNull()

    const ownerCommand = mockExec.mock.calls[1]?.[1] ?? ''
    const releaseCommand = mockExec.mock.calls[2]?.[1] ?? ''
    const token = ownerCommand.match(/printf %s '([^']+)'/)?.[1]
    expect(token).toBeTruthy()
    expect(releaseCommand).toContain(`!= '${token}'`)
  })
})

describe('gcOldRemoteInstallVersions', () => {
  // Stands in for orcad's liveness probe: only DEAD frees a dir, and an unanswered probe keeps it.
  const collectOldVersions = (
    remoteHome = '/home/u',
    currentDir = '/home/u/.orca-remote/orcad-0.1.0+bbb',
    host?: RemoteHostPlatform
  ): Promise<void> =>
    gcOldRemoteInstallVersions(conn, ORCAD_INSTALL_MODEL, remoteHome, currentDir, host, {
      isDirLive: async (dir) => {
        const answer = await mockExec(conn, `liveness ${dir}`).catch((err: unknown) => {
          if (isUnconfirmedSshCommandTermination(err)) {
            throw err
          }
          return 'UNVERIFIABLE'
        })
        return answer.trim() !== 'DEAD'
      }
    })

  beforeEach(() => {
    vi.clearAllMocks()
    mockExec.mockReset()
  })

  it('removes a sibling that is complete, unlocked, and has no live socket', async () => {
    // ls listing
    mockExec.mockResolvedValueOnce('orcad-0.1.0+aaa\norcad-0.1.0+bbb\n')
    // For sibling "aaa": safety probes pass, then GC claims the install lock before removal.
    mockExec
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OWNED')
      .mockResolvedValueOnce('MOVED')
      .mockResolvedValueOnce('RELEASED')
      .mockResolvedValueOnce('')

    await collectOldVersions()

    const lastCmd = mockExec.mock.calls.at(-1)?.[1] ?? ''
    expect(lastCmd).toContain('rm -rf')
    expect(lastCmd).toContain('orcad-0.1.0+aaa.gc-tombstone')
    const commands = mockExec.mock.calls.map(([, command]) => command)
    expect(
      commands.some((command) => command === "rm -rf '/home/u/.orca-remote/orcad-0.1.0+aaa'")
    ).toBe(false)
  })

  it('cleans only strict POSIX orphan tombstones even with no candidates', async () => {
    mockExec
      .mockResolvedValueOnce(
        [
          'orcad-0.1.0+abc.gc-tombstone.123.456',
          'orcad-0.1.0+abc.gc-tombstone.bad.456',
          'xorcad-0.1.0+abc.gc-tombstone.123.456',
          'orcad-0.1.0+abc.gc-tombstone.123.456.extra',
          'orcad-0.1.0+abc.gc-tombstone.123.456/child',
          'logs'
        ].join('\n')
      )
      .mockResolvedValueOnce('')

    await collectOldVersions()

    const removeCommands = mockExec.mock.calls
      .map(([, command]) => command)
      .filter((command) => command.startsWith('rm -rf'))
    expect(removeCommands).toEqual([
      "rm -rf '/home/u/.orca-remote/orcad-0.1.0+abc.gc-tombstone.123.456'"
    ])
  })

  it('cleans only strict Windows orphan tombstones even with no candidates', async () => {
    const windows = getRemoteHostPlatform('win32-x64')
    mockExec
      .mockResolvedValueOnce(
        'orcad-v0.1.0.gc-tombstone.123.456\norcad-v0.1.0.gc-tombstone.latest.456\n'
      )
      .mockResolvedValueOnce('')

    await collectOldVersions('C:/Users/u', 'C:/Users/u/.orca-remote/orcad-0.1.0+bbb', windows)

    const removeScript = decodePowerShellCommand(mockExec.mock.calls[1]?.[1] ?? '')
    expect(removeScript).toContain('orcad-v0.1.0.gc-tombstone.123.456')
    expect(removeScript).not.toContain('orcad-v0.1.0.gc-tombstone.latest.456')
  })

  it('retries orphan tombstone cleanup on a later GC pass', async () => {
    const tombstone = 'orcad-0.1.0+abc.gc-tombstone.123.456'
    mockExec
      .mockResolvedValueOnce(tombstone)
      .mockRejectedValueOnce(new Error('remove failed'))
      .mockResolvedValueOnce(tombstone)
      .mockResolvedValueOnce('')

    await collectOldVersions()
    await collectOldVersions()

    const removeCommands = mockExec.mock.calls
      .map(([, command]) => command)
      .filter((command) => command.startsWith('rm -rf'))
    expect(removeCommands).toHaveLength(2)
  })

  it('retries only an unknown claim release and stops after observing a lost generation', async () => {
    mockExec
      .mockResolvedValueOnce('orcad-0.1.0+aaa\n')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OWNED')
      .mockResolvedValueOnce('MOVED')
      .mockResolvedValueOnce('UNKNOWN')
      .mockResolvedValueOnce('LOST')
      .mockResolvedValueOnce('')

    await collectOldVersions()

    const releaseCommands = mockExec.mock.calls
      .map(([, command]) => command)
      .filter((command) => command.includes('.gc-owner') && command.includes('echo RELEASED'))
    expect(releaseCommands).toHaveLength(2)
  })

  it('skips siblings that are missing .install-complete (mid-install or partial)', async () => {
    mockExec.mockResolvedValueOnce('orcad-0.1.0+aaa\n')
    mockExec
      .mockResolvedValueOnce('OPEN') // not locked
      .mockResolvedValueOnce('PARTIAL') // missing .install-complete
    await collectOldVersions()
    const cmds = mockExec.mock.calls.map(([, c]) => c)
    expect(cmds.some((c) => c.includes('rm -rf'))).toBe(false)
  })

  it('skips siblings whose .install-lock is held and fresh', async () => {
    mockExec.mockResolvedValueOnce('orcad-0.1.0+aaa\n')
    mockExec.mockResolvedValueOnce('LOCKED')
    // isLockStale: age ~now → not stale.
    mockExec.mockResolvedValueOnce('0\n')
    await collectOldVersions()
    const cmds = mockExec.mock.calls.map(([, c]) => c)
    expect(cmds.some((c) => c.includes('rm -rf'))).toBe(false)
  })

  it('removes a sibling with a stale lock + .install-complete (rm-lock failed mid-finalize)', async () => {
    mockExec.mockResolvedValueOnce('orcad-0.1.0+aaa\n')
    mockExec.mockResolvedValueOnce('LOCKED')
    // isLockStale: age well above the stale window → stale.
    mockExec.mockResolvedValueOnce(`${21 * 60}\n`)
    mockExec.mockResolvedValueOnce('COMPLETE') // .install-complete present
    mockExec.mockResolvedValueOnce('DEAD') // liveness probe
    mockExec.mockResolvedValueOnce('OK') // stable sibling GC claim
    mockExec.mockResolvedValueOnce('') // write claim ownership token
    mockExec.mockResolvedValueOnce('LOCKED')
    mockExec.mockResolvedValueOnce(`${21 * 60}\n`)
    mockExec.mockResolvedValueOnce('COMPLETE')
    mockExec.mockResolvedValueOnce('DEAD')
    mockExec.mockResolvedValueOnce('OWNED')
    mockExec.mockResolvedValueOnce('MOVED')
    mockExec.mockResolvedValueOnce('RELEASED') // release sibling claim
    mockExec.mockResolvedValueOnce('') // remove tombstone
    await collectOldVersions()
    const lastCmd = mockExec.mock.calls.at(-1)?.[1] ?? ''
    expect(lastCmd).toContain('rm -rf')
    expect(lastCmd).toContain('orcad-0.1.0+aaa')
  })

  it('skips siblings whose liveness probe reports them live', async () => {
    mockExec.mockResolvedValueOnce('orcad-0.1.0+aaa\n')
    mockExec
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('ALIVE')
    await collectOldVersions()
    const cmds = mockExec.mock.calls.map(([, c]) => c)
    expect(cmds.some((c) => c.includes('rm -rf'))).toBe(false)
  })

  it('keeps a sibling when the install-lock probe fails or returns unexpected output', async () => {
    mockExec
      .mockResolvedValueOnce('orcad-0.1.0+aaa\norcad-0.1.0+ccc\n')
      .mockRejectedValueOnce(new Error('lock probe failed'))
      .mockResolvedValueOnce('INCONCLUSIVE')

    await collectOldVersions()

    expect(mockExec).toHaveBeenCalledTimes(3)
  })

  it('keeps a sibling when the liveness probe fails or returns unexpected output', async () => {
    mockExec
      .mockResolvedValueOnce('orcad-0.1.0+aaa\norcad-0.1.0+ccc\n')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockRejectedValueOnce(new Error('liveness probe failed'))
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('INCONCLUSIVE')

    await collectOldVersions()

    expect(mockExec).toHaveBeenCalledTimes(7)
  })

  it('does not consider the current dir as a GC candidate', async () => {
    mockExec.mockResolvedValueOnce('orcad-0.1.0+aaa\n')
    await collectOldVersions('/home/u', '/home/u/.orca-remote/orcad-0.1.0+aaa')
    expect(mockExec.mock.calls.length).toBe(1) // only the listing
  })

  it('ignores entries that do not match the model version dir regex (allowlist)', async () => {
    mockExec.mockResolvedValueOnce('logs\nbackup\norcad-0.1.0+aaa\n')
    mockExec
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OWNED')
      .mockResolvedValueOnce('MOVED')
      .mockResolvedValueOnce('RELEASED')
      .mockResolvedValueOnce('')
    await collectOldVersions()
    const cmds = mockExec.mock.calls.map(([, c]) => c)
    const rmCmds = cmds.filter((c) => c.startsWith('rm') && c.includes('gc-tombstone'))
    expect(rmCmds).toHaveLength(1)
    expect(rmCmds[0]).toContain('orcad-0.1.0+aaa')
    expect(rmCmds[0]).not.toContain('logs')
    expect(rmCmds[0]).not.toContain('backup')
  })

  it('does not remove a candidate claimed by repair after the initial lock probe', async () => {
    mockExec
      .mockResolvedValueOnce('orcad-0.1.0+aaa\n')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD') // liveness probe
      .mockResolvedValueOnce('OK') // GC sibling claim
      .mockResolvedValueOnce('') // write claim ownership token
      .mockResolvedValueOnce('LOCKED') // repair won before the safety recheck
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('RELEASED') // release GC sibling claim

    await collectOldVersions()

    const commands = mockExec.mock.calls.map(([, command]) => command)
    expect(
      commands.some(
        (command) =>
          command.startsWith("rm -rf '/home/u/.orca-remote/orcad-0.1.0+aaa'") &&
          !command.includes('.install-lock')
      )
    ).toBe(false)
  })

  it('does not move a candidate after losing the sibling claim generation', async () => {
    mockExec
      .mockResolvedValueOnce('orcad-0.1.0+aaa\n')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('LOST')
      .mockResolvedValueOnce('LOST')

    await collectOldVersions()

    const commands = mockExec.mock.calls.map(([, command]) => command)
    expect(commands.some((command) => command.startsWith('mv '))).toBe(false)
  })

  it('releases the GC claim after a confirmed move failure', async () => {
    mockExec
      .mockResolvedValueOnce('orcad-0.1.0+aaa\n')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OWNED')
      .mockRejectedValueOnce(new Error('move failed'))
      .mockResolvedValueOnce('RELEASED')

    await collectOldVersions()

    const lastCommand = mockExec.mock.calls.at(-1)?.[1] ?? ''
    expect(lastCommand).toContain('rm -rf')
    expect(lastCommand).toContain('orcad-0.1.0+aaa.gc-claim')
  })

  it('keeps the GC claim when remote move termination is unconfirmed', async () => {
    const unconfirmed = Object.assign(new Error('move timed out'), {
      sshChannelCloseConfirmed: false
    })
    mockExec
      .mockResolvedValueOnce('orcad-0.1.0+aaa\n')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OWNED')
      .mockRejectedValueOnce(unconfirmed)

    await expect(collectOldVersions()).rejects.toBe(unconfirmed)

    const releaseCommands = mockExec.mock.calls
      .map(([, command]) => command)
      .filter((command) => command.includes('orcad-0.1.0+aaa.gc-claim') && command.startsWith('rm'))
    expect(releaseCommands).toHaveLength(0)
  })
})
