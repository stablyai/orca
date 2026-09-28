import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RelayRipgrepInstallModule from './ssh-relay-ripgrep-install'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

// Why: deployAndLaunchRelay now reads `${localRelayDir}/.version` upfront
// (per docs/ssh-relay-versioned-install-dirs.md). The fs mock must report
// the local relay package as existing AND return a content-hashed version
// string so readLocalFullVersion succeeds.
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn((os: string, arch: string) => {
    const normalizedOs = os.toLowerCase()
    const normalizedArch = arch.toLowerCase()
    const relayArch = normalizedArch === 'arm64' || normalizedArch === 'aarch64' ? 'arm64' : 'x64'
    if (normalizedOs === 'windows' || normalizedOs === 'win32') {
      return `win32-${relayArch}`
    }
    if (normalizedOs === 'darwin') {
      return `darwin-${relayArch}`
    }
    if (normalizedOs === 'linux') {
      return `linux-${relayArch}`
    }
    return null
  }),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
}))

vi.mock('./ssh-relay-bun-runtime', () => ({
  ensureRemoteRelayBunRuntime: vi.fn().mockResolvedValue('/usr/bin/node')
}))

// Why: this file mocks fs, so the real content hash cannot read a binary.
vi.mock('../ripgrep/bundled-ripgrep-path', () => ({
  resolveBundledRipgrepPath: () => null,
  bundledRipgrepContentKey: () => 'c0ffee0123456789'
}))

// Why: the fire-and-forget ripgrep install would drain the queued exec mocks.
// Why: the post-launch ripgrep cache GC is fire-and-forget and would drain the queued exec mocks.
vi.mock('./ssh-relay-ripgrep-cache-gc', () => ({ gcRemoteRipgrepCache: vi.fn() }))
vi.mock('./ssh-relay-ripgrep-install', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayRipgrepInstallModule>()),
  ensureRemoteBundledRipgrep: vi.fn().mockResolvedValue('present'),
  recordRemoteRipgrepReference: vi.fn().mockResolvedValue(true)
}))

// Why: the versioned-install modules shell out for install state, locking,
// and GC. Stub them so deploy tests need no real SSH connection.
vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`,
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), {
      name: 'AbortError'
    })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { ensureRemoteRelayBunRuntime } from './ssh-relay-bun-runtime'
import { isRelayAlreadyInstalled, gcOldRelayVersions } from './ssh-relay-versioned-install'
import { acquireInstallLock } from './ssh-relay-install-lock'
import {
  ensureRemoteBundledRipgrep,
  recordRemoteRipgrepReference
} from './ssh-relay-ripgrep-install'
import { gcRemoteRipgrepCache } from './ssh-relay-ripgrep-cache-gc'
import * as DeployTiming from './ssh-relay-deploy-timing'
import type { SshConnection } from './ssh-connection'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../shared/ssh-types'

function makeMockConnection(): SshConnection {
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sftp: vi.fn().mockResolvedValue({
      mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
      createWriteStream: vi.fn().mockReturnValue({
        on: vi.fn((_event: string, cb: () => void) => {
          if (_event === 'close') {
            setTimeout(cb, 0)
          }
        }),
        end: vi.fn()
      }),
      end: vi.fn()
    })
  } as unknown as SshConnection
}

function queueLaunchNamespaceAndDeadSocketProbe(): void {
  vi.mocked(execCommand).mockResolvedValueOnce('').mockResolvedValueOnce('DEAD')
}

function queueFreshLinuxDeploy(): void {
  vi.mocked(execCommand)
    .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    .mockResolvedValueOnce('/home/user')
    .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
  queueLaunchNamespaceAndDeadSocketProbe()
  vi.mocked(execCommand).mockResolvedValueOnce('READY')
}

function detachedLaunchCommand(conn: SshConnection): string | undefined {
  return vi
    .mocked(conn.exec)
    .mock.calls.map(([cmd]) => cmd as string)
    .find((cmd) => cmd.includes('--detached'))
}

describe('deployAndLaunchRelay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    vi.mocked(waitForSentinel).mockReset().mockResolvedValue({
      write: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn()
    })
    vi.mocked(ensureRemoteRelayBunRuntime).mockReset().mockResolvedValue('/usr/bin/node')
    vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(true)
    vi.mocked(acquireInstallLock).mockReset().mockResolvedValue(undefined)
  })

  it('calls exec to detect remote platform', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // echo $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    await deployAndLaunchRelay(conn)

    const runtimeCommands = mockExecCommand.mock.calls
      .map((call) => call[1])
      .filter((command) => command.includes('--no-env-file'))
    expect(runtimeCommands.length).toBeGreaterThan(1)
    expect(runtimeCommands.every((command) => command.includes('--no-install'))).toBe(true)
    expect(mockExecCommand).toHaveBeenCalledWith(
      conn,
      "printf '\\n%s ' '__ORCA_REMOTE_PLATFORM__'; uname -sm",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('reports progress via callback', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    const progress: string[] = []
    await deployAndLaunchRelay(conn, (status) => progress.push(status))

    expect(progress).toContain('Detecting remote platform...')
    expect(progress).toContain('Starting relay...')
  })

  it('does not launch fresh after an unconfirmed endpoint-incumbent probe', async () => {
    const conn = makeMockConnection()
    const unconfirmedCleanup = Object.assign(new Error('endpoint probe still running'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('stale relay reconnect failed'))
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('') // launch namespace marker
      .mockResolvedValueOnce('ALIVE')
      .mockRejectedValueOnce(unconfirmedCleanup)

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(unconfirmedCleanup)

    const commands = vi.mocked(conn.exec).mock.calls.map(([command]) => command)
    expect(commands).toHaveLength(1)
    expect(
      commands.filter((command) => /--detached|\brm -f\b|\bkill\s/.test(command))
    ).toHaveLength(0)
  })

  it('resolves the bundled Bun runtime once per deploy', async () => {
    const conn = makeMockConnection()
    queueFreshLinuxDeploy()

    await deployAndLaunchRelay(conn)

    expect(ensureRemoteRelayBunRuntime).toHaveBeenCalledTimes(1)
  })

  it('resolves the remote home before installing the bundled runtime', async () => {
    const conn = makeMockConnection()
    queueFreshLinuxDeploy()
    await deployAndLaunchRelay(conn)
    expect(ensureRemoteRelayBunRuntime).toHaveBeenCalledWith(
      conn,
      expect.objectContaining({ os: 'linux' }),
      '/home/user',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('does not start a runtime install when the host home probe fails', async () => {
    const conn = makeMockConnection()
    const error = new Error('home probe failed')
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockRejectedValueOnce(error)
    await expect(deployAndLaunchRelay(conn)).rejects.toThrow('home probe failed')
    expect(ensureRemoteRelayBunRuntime).not.toHaveBeenCalled()
    expect(conn.exec).not.toHaveBeenCalled()
  })

  it('does not launch or retry after an unconfirmed Bun installation', async () => {
    const conn = makeMockConnection()
    queueFreshLinuxDeploy()
    const error = Object.assign(new Error('runtime install uncertain'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(ensureRemoteRelayBunRuntime).mockRejectedValueOnce(error)
    await expect(deployAndLaunchRelay(conn)).rejects.toBe(error)
    expect(ensureRemoteRelayBunRuntime).toHaveBeenCalledOnce()
    expect(conn.exec).not.toHaveBeenCalled()
  })

  it('defaults fresh relays to keep-alive-until-reset without rollout artifacts', async () => {
    const conn = makeMockConnection()
    queueFreshLinuxDeploy()

    await deployAndLaunchRelay(conn)

    const launchCommand = detachedLaunchCommand(conn)

    expect(launchCommand).toContain(`--grace-time ${DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS}`)
    expect(launchCommand).toContain(
      "--ripgrep-path '/home/user/.orca-remote/ripgrep/c0ffee0123456789-linux-x64/rg'"
    )
    await vi.waitFor(() =>
      expect(ensureRemoteBundledRipgrep).toHaveBeenCalledWith(
        conn,
        expect.anything(),
        '/home/user',
        expect.objectContaining({ signal: expect.anything() })
      )
    )
    expect(launchCommand).not.toContain('--pty-source-credit-v1')
    expect(launchCommand).not.toContain('.pty-source-credit-policy')
  })

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    'waits for ripgrep before cleanup (concurrent exec: %s, upload failure: %s)',
    async (concurrent, fails) => {
      const conn = makeMockConnection()
      vi.mocked(conn.canRunConcurrentExecCommands).mockReturnValue(concurrent)
      queueFreshLinuxDeploy()
      let finishUpload = (): void => {}
      vi.mocked(ensureRemoteBundledRipgrep).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishUpload = () => (fails ? reject(new Error('upload failed')) : resolve('present'))
          })
      )
      await deployAndLaunchRelay(conn)
      expect(ensureRemoteBundledRipgrep).toHaveBeenCalledOnce()
      const execCount = vi.mocked(execCommand).mock.calls.length
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(execCommand).toHaveBeenCalledTimes(execCount)
      expect(gcOldRelayVersions).not.toHaveBeenCalled()
      finishUpload()
      await vi.waitFor(() => expect(gcOldRelayVersions).toHaveBeenCalledOnce())
    }
  )

  it('uses the required Bun runtime without installing a second SQLite runtime', async () => {
    const conn = makeMockConnection()
    queueFreshLinuxDeploy()
    await deployAndLaunchRelay(conn)
    await vi.waitFor(() => expect(gcOldRelayVersions).toHaveBeenCalledOnce())
    expect(ensureRemoteRelayBunRuntime).toHaveBeenCalledOnce()
  })

  it('does not launch or upload an unprotected binary when recording its reference fails', async () => {
    const conn = makeMockConnection()
    queueFreshLinuxDeploy()
    vi.mocked(recordRemoteRipgrepReference).mockResolvedValueOnce(false)
    await deployAndLaunchRelay(conn)
    expect(detachedLaunchCommand(conn)).not.toContain('--ripgrep-path')
    expect(ensureRemoteBundledRipgrep).not.toHaveBeenCalled()
  })

  it('does not launch after an unconfirmed ripgrep reference write', async () => {
    const conn = makeMockConnection()
    queueFreshLinuxDeploy()
    const error = Object.assign(new Error('reference write still running'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(recordRemoteRipgrepReference).mockRejectedValueOnce(error)

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(error)
    expect(detachedLaunchCommand(conn)).toBeUndefined()
    expect(ensureRemoteBundledRipgrep).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'blocks cleanup after uncertain ripgrep teardown (concurrent exec: %s)',
    async (concurrent) => {
      const conn = makeMockConnection()
      vi.mocked(conn.canRunConcurrentExecCommands).mockReturnValue(concurrent)
      queueFreshLinuxDeploy()
      vi.mocked(ensureRemoteBundledRipgrep).mockRejectedValueOnce(
        Object.assign(new Error('upload still running'), { sshChannelCloseConfirmed: false })
      )
      await deployAndLaunchRelay(conn)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(gcOldRelayVersions).not.toHaveBeenCalled()
      expect(gcRemoteRipgrepCache).not.toHaveBeenCalled()
      const execCount = vi.mocked(execCommand).mock.calls.length
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(execCommand).toHaveBeenCalledTimes(execCount)
    }
  )

  it.each([false, true])(
    'does not continue cache cleanup after failed version GC (confirmed: %s)',
    async (confirmed) => {
      const conn = makeMockConnection()
      queueFreshLinuxDeploy()
      vi.mocked(gcOldRelayVersions).mockRejectedValueOnce(
        Object.assign(new Error('GC interrupted'), { sshChannelCloseConfirmed: confirmed })
      )
      await deployAndLaunchRelay(conn)
      await vi.waitFor(() => expect(gcOldRelayVersions).toHaveBeenCalledOnce())
      expect(gcRemoteRipgrepCache).not.toHaveBeenCalled()
    }
  )

  it('allows an unlimited SSH disconnect grace window', async () => {
    const conn = makeMockConnection()
    queueFreshLinuxDeploy()

    await deployAndLaunchRelay(conn, undefined, 0, 'target-a')

    const launchCommand = detachedLaunchCommand(conn)

    expect(launchCommand).toContain('--grace-time 0')
    expect(launchCommand).not.toContain('--pty-source-credit-v1')
    expect(launchCommand).not.toContain('.pty-source-credit-policy')
  })

  it('clamps configured SSH disconnect grace to the seven-day maximum', async () => {
    const conn = makeMockConnection()
    queueFreshLinuxDeploy()

    await deployAndLaunchRelay(conn, undefined, MAX_SSH_RELAY_GRACE_PERIOD_SECONDS + 1, 'target-a')

    const launchCommand = detachedLaunchCommand(conn)

    expect(launchCommand).toContain(`--grace-time ${MAX_SSH_RELAY_GRACE_PERIOD_SECONDS}`)
  })

  it('uses a content-hashed versioned remote install directory', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    queueFreshLinuxDeploy()

    await deployAndLaunchRelay(conn)

    // The launch + connect commands include the versioned dir path.
    const execArgs = vi.mocked(conn.exec).mock.calls.map(([cmd]) => cmd as string)
    const allCmds = [...execArgs, ...mockExecCommand.mock.calls.map(([, cmd]) => cmd)]
    const sawVersionedDir = allCmds.some((cmd) =>
      cmd.includes('/.orca-remote/relay-0.1.0+abcdef012345')
    )
    expect(sawVersionedDir).toBe(true)
    const sawLegacyDir = allCmds.some((cmd) => cmd.includes('relay-v0.1.0'))
    expect(sawLegacyDir).toBe(false)
  })

  it('bounds the overall deploy so install + rebuild both fit under the timeout', async () => {
    // Why: the outer bound must exceed the worst-case sequential native-deps
    // work — a first install (240s) AND a follow-up rebuild (240s) — so a
    // legitimate install-then-rebuild is not falsely timed out mid-repair.
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)

    // Make the first exec never resolve
    mockExecCommand.mockReturnValueOnce(new Promise(() => {}))

    vi.useFakeTimers()

    // Catch the rejection immediately to avoid unhandled rejection warning
    const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)

    // Not timed out yet at the old 300s bound (install + rebuild need more).
    await vi.advanceTimersByTimeAsync(301_000)
    expect(await Promise.race([promise, Promise.resolve('pending')])).toBe('pending')

    await vi.advanceTimersByTimeAsync(DeployTiming.RELAY_DEPLOY_TIMEOUT_MS - 301_000)
    expect(await Promise.race([promise, Promise.resolve('pending')])).toBe('pending')

    await vi.advanceTimersByTimeAsync(DeployTiming.RELAY_DEPLOY_TEARDOWN_TIMEOUT_MS)

    const result = await promise
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe('Relay deployment timed out after 900s')

    vi.useRealTimers()
  })

  it('aborts a contended install-lock wait at the overall deploy timeout', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeMockConnection()
      vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(false)
      conn.uploadDirectory = vi.fn().mockResolvedValue(undefined)
      conn.writeFile = vi.fn().mockResolvedValue(undefined)
      vi.mocked(execCommand).mockImplementation((_conn, command) => {
        if (command.includes('uname')) {
          return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
        }
        if (command === 'echo $HOME') {
          return Promise.resolve('/home/user')
        }
        const marker = command.match(/\.sftp-namespace-[0-9a-f]{32}/u)?.[0]
        if (command.includes('__ORCA_UPLOAD_STAGE_SLOT__') && marker) {
          return Promise.resolve(`__ORCA_UPLOAD_STAGE_SLOT__${marker}:slot-0`)
        }
        return Promise.resolve('')
      })
      vi.mocked(isRelayAlreadyInstalled).mockResolvedValueOnce(false)
      let lockSignal: AbortSignal | undefined
      vi.mocked(acquireInstallLock).mockImplementationOnce((_conn, _dir, _host, options) => {
        lockSignal = options?.signal
        return new Promise<void>((_resolve, reject) => {
          lockSignal?.addEventListener('abort', () => reject(lockSignal?.reason), { once: true })
        })
      })

      const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.advanceTimersByTimeAsync(0)
      expect(acquireInstallLock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(DeployTiming.RELAY_DEPLOY_TIMEOUT_MS)

      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('Relay deployment timed out after 900s')
      expect(lockSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a launch started near the deploy deadline and closes its channel once', async () => {
    vi.useFakeTimers()
    try {
      const launchChannel = {
        on: vi.fn(),
        stderr: { on: vi.fn() },
        stdin: {},
        stdout: { on: vi.fn() },
        close: vi.fn()
      }
      const conn = makeMockConnection()
      vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(true)
      vi.mocked(conn.exec).mockResolvedValue(launchChannel as never)
      const mockExecCommand = vi.mocked(execCommand)
      mockExecCommand
        .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
        .mockResolvedValueOnce('/home/user')
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) =>
              setTimeout(() => resolve('ORCA-NATIVE-DEPS-OK'), 899_900)
            )
        )
        .mockResolvedValueOnce('') // launch namespace marker
        .mockResolvedValueOnce('DEAD')
        .mockImplementationOnce((_conn, _command, options) => {
          return new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('SSH operation was cancelled')
                error.name = 'AbortError'
                reject(error)
              },
              { once: true }
            )
          })
        })

      const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.advanceTimersByTimeAsync(899_900)
      expect(conn.exec).toHaveBeenCalledTimes(1)
      expect(launchChannel.close).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(100)

      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('Relay deployment timed out after 900s')
      expect(launchChannel.close).toHaveBeenCalledTimes(1)
      expect(mockExecCommand).toHaveBeenCalledTimes(6)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockExecCommand).toHaveBeenCalledTimes(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses distinct target-specific relay socket paths', async () => {
    const connA = makeMockConnection()
    const connB = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockImplementation((_conn, command) => {
      if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('ORCA-NATIVE')) {
        return Promise.resolve('ORCA-NATIVE-DEPS-OK')
      }
      if (command.includes('process.stdout.write("READY")')) {
        return Promise.resolve('READY')
      }
      if (command.includes('test -S')) {
        return Promise.resolve('DEAD')
      }
      return Promise.resolve('')
    })

    await deployAndLaunchRelay(connA, undefined, 300, 'target-a')
    await deployAndLaunchRelay(connB, undefined, 300, 'target-b')

    const probeCommands = mockExecCommand.mock.calls
      .map(([, command]) => command)
      .filter(
        (command) =>
          command.includes('test -S') && command.includes('relay-') && command.includes('ALIVE')
      )
    expect(probeCommands).toHaveLength(2)
    expect(probeCommands[0]).toContain('relay-')
    expect(probeCommands[0]).not.toContain('relay.sock')
    expect(probeCommands[1]).toContain('relay-')
    expect(probeCommands[1]).not.toContain('relay.sock')
    expect(probeCommands[0]).not.toEqual(probeCommands[1])

    const launchA = vi.mocked(connA.exec).mock.calls.at(-1)?.[0] ?? ''
    const launchB = vi.mocked(connB.exec).mock.calls.at(-1)?.[0] ?? ''
    expect(launchA).toContain('--sock-path')
    expect(launchB).toContain('--sock-path')
    expect(launchA).not.toEqual(launchB)
  })
})
