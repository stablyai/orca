import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  execCommand: vi.fn().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

// Why: the versioned-install module shells out to the remote for install
// state, lock acquisition, and GC. Tests stub these to no-ops so the deploy
// happy-path is exercised without a real SSH connection.
vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import type { SshConnection } from './ssh-connection'
import type * as SshRemoteNodeResolution from './ssh-remote-node-resolution'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../shared/ssh-types'

function decodePowerShellCommand(command: string): string | null {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : null
}

function extractWindowsSockPath(script: string): string {
  return /--sock-path\s+'([^']+)'/.exec(script)?.[1] ?? ''
}

function extractWindowsMarkerPath(script: string): string {
  return /-LiteralPath\s+'([^']*\.windows-active-pipe[^']*)'/.exec(script)?.[1] ?? ''
}

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

describe('deployAndLaunchRelay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls exec to detect remote platform', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // echo $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    await deployAndLaunchRelay(conn)

    expect(mockExecCommand).toHaveBeenCalledWith(
      conn,
      "printf '\\n%s ' '__ORCA_REMOTE_PLATFORM__'; uname -sm"
    )
  })

  it('reports progress via callback', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    const progress: string[] = []
    await deployAndLaunchRelay(conn, (status) => progress.push(status))

    expect(progress).toContain('Detecting remote platform...')
    expect(progress).toContain('Starting relay...')
  })

  it('resolves the remote node path once per deploy', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    mockExecCommand.mockResolvedValueOnce('DEAD')
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn)

    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('resolves node concurrently with remote home, not after the install-state chain', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe

    let markNodeResolutionStarted: () => void = () => {}
    const nodeResolutionStarted = new Promise<void>((resolve) => {
      markNodeResolutionStarted = resolve
    })
    vi.mocked(resolveRemoteNodePath).mockImplementationOnce(() => {
      markNodeResolutionStarted()
      return Promise.resolve('/usr/bin/node')
    })

    // Hold the first install-state step open. The optimization starts the node
    // branch before the remote-home -> install-check chain finishes.
    let releaseRemoteHome: (home: string) => void = () => {}
    mockExecCommand.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseRemoteHome = resolve
      })
    )

    const deployPromise = deployAndLaunchRelay(conn)
    let assertionError: unknown
    let deployError: unknown
    try {
      await nodeResolutionStarted

      expect(isRelayAlreadyInstalled).not.toHaveBeenCalled()
      expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
    } catch (err) {
      assertionError = err
    } finally {
      // Drain the rest of the happy path so a failed assertion does not leave
      // the deploy promise pending until its 300s timeout.
      mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
      mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
      mockExecCommand.mockResolvedValueOnce('READY') // socket poll
      releaseRemoteHome('/home/user')
      deployError = await deployPromise.then(
        () => undefined,
        (err: unknown) => err
      )
    }
    if (assertionError) {
      throw assertionError
    }
    if (deployError) {
      throw deployError
    }
  })

  it('keeps bootstrap sequential when the connection cannot run concurrent exec commands', async () => {
    const conn = makeMockConnection()
    vi.mocked(conn.canRunConcurrentExecCommands).mockReturnValue(false)
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    let releaseRemoteHome: (home: string) => void = () => {}
    let remoteHomeProbeStarted: () => void = () => {}
    const remoteHomeProbeStartedPromise = new Promise<void>((resolve) => {
      remoteHomeProbeStarted = resolve
    })
    mockExecCommand.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        remoteHomeProbeStarted()
        releaseRemoteHome = resolve
      })
    )

    const deployPromise = deployAndLaunchRelay(conn)
    await remoteHomeProbeStartedPromise
    expect(resolveRemoteNodePath).not.toHaveBeenCalled()

    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll
    releaseRemoteHome('/home/user')
    await deployPromise
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('falls back to sequential bootstrap when concurrent SSH sessions are refused', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    const { resolveRemoteNodePath: resolveRemoteNodePathActual } = await vi.importActual<
      typeof SshRemoteNodeResolution
    >('./ssh-remote-node-resolution')
    let fallbackInstallStateCompleted = false
    vi.mocked(resolveRemoteNodePath)
      .mockImplementationOnce(resolveRemoteNodePathActual)
      .mockImplementationOnce(() => {
        if (!fallbackInstallStateCompleted) {
          throw new Error('Sequential fallback resolved node before install state finished')
        }
        return Promise.resolve('/usr/bin/node')
      })
    vi.mocked(isRelayAlreadyInstalled)
      .mockImplementationOnce(async (_conn, _dir, _host, options) => {
        expect(options?.rethrowSessionLimitErrors).toBe(true)
        return true
      })
      .mockImplementationOnce(async (_conn, _dir, _host, options) => {
        expect(options?.rethrowSessionLimitErrors).toBeUndefined()
        fallbackInstallStateCompleted = true
        return true
      })
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // concurrent install-state $HOME
    mockExecCommand.mockRejectedValueOnce(sessionLimitError) // concurrent node path probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // sequential fallback $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    await deployAndLaunchRelay(conn)

    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(2)
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(2)
  })

  it('falls back to sequential bootstrap when the install-state probe hits a session limit', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    vi.mocked(isRelayAlreadyInstalled)
      .mockImplementationOnce(async (_conn, _dir, _host, options) => {
        if (!options?.rethrowSessionLimitErrors) {
          return true
        }
        throw sessionLimitError
      })
      .mockResolvedValueOnce(true)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // concurrent install-state $HOME
    mockExecCommand.mockResolvedValueOnce('/home/user') // sequential fallback $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    await deployAndLaunchRelay(conn)

    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(2)
    expect(vi.mocked(isRelayAlreadyInstalled).mock.calls[0]?.[3]).toMatchObject({
      rethrowSessionLimitErrors: true
    })
    expect(vi.mocked(isRelayAlreadyInstalled).mock.calls[1]?.[3]).toBeUndefined()
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(2)
  })

  it('does not retry bootstrap for non-session failures', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const nodeError = new Error('Node.js not found on remote host')
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(nodeError)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // concurrent install-state $HOME

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(nodeError)
    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(1)
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('aborts a pending sibling probe and preserves a non-session install-state failure', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    let nodeProbeAborted = false
    vi.mocked(resolveRemoteNodePath).mockImplementationOnce((_conn, _host, options) => {
      return new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          nodeProbeAborted = true
          const abortError = new Error('aborted')
          abortError.name = 'AbortError'
          reject(abortError)
        })
      })
    })
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('relative-home') // invalid install-state $HOME

    const timedDeploy = Promise.race([
      deployAndLaunchRelay(conn),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('deploy did not fail promptly')), 100)
      })
    ])

    await expect(timedDeploy).rejects.toThrow(/Remote home is not a valid path/)
    expect(nodeProbeAborted).toBe(true)
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('does not retry when a session-limit failure races with a real install-state failure', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    const installError = new Error('permission denied while checking relay install')
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(sessionLimitError)
    vi.mocked(isRelayAlreadyInstalled).mockRejectedValueOnce(installError)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // concurrent install-state $HOME

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(installError)
    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(1)
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('does not retry until the surviving first-attempt probe settles', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    let releaseRemoteHome: (home: string) => void = () => {}
    let remoteHomeSettled = false
    mockExecCommand.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseRemoteHome = (home: string) => {
          remoteHomeSettled = true
          resolve(home)
        }
      })
    )
    vi.mocked(resolveRemoteNodePath).mockImplementationOnce(() => Promise.reject(sessionLimitError))
    vi.mocked(resolveRemoteNodePath).mockImplementationOnce(() => {
      if (!remoteHomeSettled) {
        throw new Error('Sequential fallback started before first install-state probe settled')
      }
      return Promise.resolve('/usr/bin/node')
    })

    const deployPromise = deployAndLaunchRelay(conn)
    await vi.waitFor(() => expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)

    mockExecCommand.mockResolvedValueOnce('/home/user') // sequential fallback $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll
    releaseRemoteHome('/home/user')
    await deployPromise
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(2)
  })

  it('defaults fresh relays to keep-alive-until-reset', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    mockExecCommand.mockResolvedValueOnce('DEAD')
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn)

    const launchCommand = vi
      .mocked(conn.exec)
      .mock.calls.map(([cmd]) => cmd as string)
      .find((cmd) => cmd.includes('--detached'))

    expect(launchCommand).toContain(`--grace-time ${DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS}`)
  })

  it('allows an unlimited SSH disconnect grace window', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    mockExecCommand.mockResolvedValueOnce('DEAD')
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn, undefined, 0, 'target-a')

    const launchCommand = vi
      .mocked(conn.exec)
      .mock.calls.map(([cmd]) => cmd as string)
      .find((cmd) => cmd.includes('--detached'))

    expect(launchCommand).toContain('--grace-time 0')
  })

  it('clamps configured SSH disconnect grace to the seven-day maximum', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    mockExecCommand.mockResolvedValueOnce('DEAD')
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn, undefined, MAX_SSH_RELAY_GRACE_PERIOD_SECONDS + 1, 'target-a')

    const launchCommand = vi
      .mocked(conn.exec)
      .mock.calls.map(([cmd]) => cmd as string)
      .find((cmd) => cmd.includes('--detached'))

    expect(launchCommand).toContain(`--grace-time ${MAX_SSH_RELAY_GRACE_PERIOD_SECONDS}`)
  })

  it('uses a content-hashed versioned remote install directory', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    mockExecCommand.mockResolvedValueOnce('DEAD')
    mockExecCommand.mockResolvedValueOnce('READY')

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

  it('has a 300-second overall timeout', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)

    // Make the first exec never resolve
    mockExecCommand.mockReturnValueOnce(new Promise(() => {}))

    vi.useFakeTimers()

    // Catch the rejection immediately to avoid unhandled rejection warning
    const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)

    await vi.advanceTimersByTimeAsync(301_000)

    const result = await promise
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe('Relay deployment timed out after 300s')

    vi.useRealTimers()
  })

  it('uses distinct target-specific relay socket paths', async () => {
    const connA = makeMockConnection()
    const connB = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe A
      .mockResolvedValueOnce('/home/user') // $HOME A
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe A
      .mockResolvedValueOnce('DEAD') // probe A
      .mockResolvedValueOnce('READY') // poll A
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe B
      .mockResolvedValueOnce('/home/user') // $HOME B
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe B
      .mockResolvedValueOnce('DEAD') // probe B
      .mockResolvedValueOnce('READY') // poll B

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

  it('launches Windows remotes via a named pipe endpoint', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64') // tagged PowerShell platform probe
      .mockResolvedValueOnce('C:\\Users\\me user') // remote home
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
      .mockResolvedValueOnce('') // no persisted active pipe
      .mockResolvedValueOnce('WAITING') // named pipe probe
      .mockResolvedValueOnce('') // WMI relay launch
      .mockResolvedValueOnce('READY') // named pipe poll
      .mockResolvedValueOnce('') // persist active pipe marker

    const result = await deployAndLaunchRelay(conn, undefined, 300, 'target-a')

    expect(result.platform).toBe('win32-x64')
    expect(result.remoteHome).toBe('C:/Users/me user')
    expect(result.sockPath).toMatch(/^\\\\\.\\pipe\\orca-relay-[0-9a-f]{20}$/)
    const execCommands = vi.mocked(conn.exec).mock.calls.map(([cmd]) => cmd as string)
    expect(execCommands).toHaveLength(1)
    expect(execCommands[0]).toContain('powershell.exe')
    const decodedScripts = mockExecCommand.mock.calls
      .map(([, command]) => decodePowerShellCommand(command))
      .filter((script): script is string => script !== null)
    const launchScript = decodedScripts.find((script) => script.includes('Invoke-CimMethod')) ?? ''
    expect(launchScript).toContain(
      '"C:/Users/me user/.orca-remote/relay-0.1.0+abcdef012345/relay.js"'
    )
    expect(launchScript).toContain(
      '"C:/Users/me user/.orca-remote/relay-0.1.0+abcdef012345/agent-hooks/orca-relay-'
    )
    expect(launchScript).toContain('--endpoint-dir')
    expect(launchScript).not.toContain('\\\\.\\pipe\\agent-hooks')
    const waitScript = decodedScripts.find((script) => script.includes('deadline=Date.now()')) ?? ''
    expect(waitScript).toContain('setTimeout(attempt,intervalMs)')
  })

  it('relaunches Windows remotes on a fallback pipe when reconnecting the occupied pipe fails', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    vi.mocked(waitForSentinel)
      .mockRejectedValueOnce(new Error('stale daemon handshake failed'))
      .mockResolvedValueOnce({
        write: vi.fn(),
        onData: vi.fn(),
        onClose: vi.fn()
      })
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64') // tagged PowerShell platform probe
      .mockResolvedValueOnce('C:\\Users\\me user') // remote home
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
      .mockResolvedValueOnce('') // no persisted active pipe yet
      .mockResolvedValueOnce('READY') // existing named pipe probe
      .mockResolvedValueOnce('WAITING') // deterministic fallback pipe is not already running
      .mockResolvedValueOnce('') // WMI relay launch on fallback pipe
      .mockResolvedValueOnce('READY') // fallback pipe poll
      .mockResolvedValueOnce('') // persist fallback active pipe marker

    const result = await deployAndLaunchRelay(conn, undefined, 300, 'target-a')

    const execCommands = vi.mocked(conn.exec).mock.calls.map(([cmd]) => cmd as string)
    expect(execCommands).toHaveLength(2)
    const firstConnectScript = decodePowerShellCommand(execCommands[0]) ?? ''
    const secondConnectScript = decodePowerShellCommand(execCommands[1]) ?? ''
    const primaryPipe = extractWindowsSockPath(firstConnectScript)
    const fallbackPipe = extractWindowsSockPath(secondConnectScript)
    expect(primaryPipe).toMatch(/^\\\\\.\\pipe\\orca-relay-[0-9a-f]{20}$/)
    expect(fallbackPipe).toMatch(/^\\\\\.\\pipe\\orca-relay-[0-9a-f]{20}$/)
    expect(fallbackPipe).not.toBe(primaryPipe)
    expect(result.sockPath).toBe(fallbackPipe)

    const launchScript =
      mockExecCommand.mock.calls
        .map(([, command]) => decodePowerShellCommand(command))
        .find((script) => script?.includes('Invoke-CimMethod')) ?? ''
    expect(launchScript).toContain(fallbackPipe)
    expect(launchScript).not.toContain(primaryPipe)

    const markerWriteScript =
      mockExecCommand.mock.calls
        .map(([, command]) => decodePowerShellCommand(command))
        .find(
          (script) => script?.includes('Set-Content') && script.includes('.windows-active-pipe')
        ) ?? ''
    expect(markerWriteScript).toContain(fallbackPipe)
    expect(markerWriteScript).not.toContain(primaryPipe)
  })

  it('prefers a persisted Windows fallback pipe on later reconnects', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const persistedPipe = '\\\\.\\pipe\\orca-relay-1234567890abcdef1234'
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64') // tagged PowerShell platform probe
      .mockResolvedValueOnce('C:\\Users\\me user') // remote home
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
      .mockResolvedValueOnce(`${persistedPipe}\n`) // persisted active pipe marker
      .mockResolvedValueOnce('READY') // persisted named pipe probe
      .mockResolvedValueOnce('') // refresh active pipe marker

    const result = await deployAndLaunchRelay(conn, undefined, 300, 'target-a')

    const execCommands = vi.mocked(conn.exec).mock.calls.map(([cmd]) => cmd as string)
    expect(execCommands).toHaveLength(1)
    const connectScript = decodePowerShellCommand(execCommands[0]) ?? ''
    expect(extractWindowsSockPath(connectScript)).toBe(persistedPipe)
    expect(result.sockPath).toBe(persistedPipe)

    const decodedExecScripts = mockExecCommand.mock.calls
      .map(([, command]) => decodePowerShellCommand(command))
      .filter((script): script is string => script !== null)
    expect(decodedExecScripts.some((script) => script.includes('Invoke-CimMethod'))).toBe(false)
  })

  it('scopes persisted Windows active pipe markers by relay target', async () => {
    const connA = makeMockConnection()
    const connB = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe A
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64')
      .mockResolvedValueOnce('C:\\Users\\me user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('') // no persisted active pipe A
      .mockResolvedValueOnce('WAITING')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('READY')
      .mockResolvedValueOnce('') // persist active pipe A
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe B
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64')
      .mockResolvedValueOnce('C:\\Users\\me user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('') // no persisted active pipe B
      .mockResolvedValueOnce('WAITING')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('READY')
      .mockResolvedValueOnce('') // persist active pipe B

    await deployAndLaunchRelay(connA, undefined, 300, 'target-a')
    await deployAndLaunchRelay(connB, undefined, 300, 'target-b')

    const markerPaths = mockExecCommand.mock.calls
      .map(([, command]) => decodePowerShellCommand(command))
      .filter((script): script is string => Boolean(script?.includes('Get-Content')))
      .map(extractWindowsMarkerPath)

    expect(markerPaths).toHaveLength(2)
    expect(markerPaths[0]).toContain('.windows-active-pipe-relay-')
    expect(markerPaths[1]).toContain('.windows-active-pipe-relay-')
    expect(markerPaths[0]).not.toBe(markerPaths[1])
  })
})
