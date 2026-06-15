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
  execCommand: vi.fn().mockResolvedValue('Linux x86_64')
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
import type { SshConnection } from './ssh-connection'
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
    mockExecCommand.mockResolvedValueOnce('Linux x86_64') // uname -sm
    mockExecCommand.mockResolvedValueOnce('/home/user') // echo $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    mockExecCommand.mockResolvedValueOnce('DEAD') // socket probe
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    await deployAndLaunchRelay(conn)

    expect(mockExecCommand).toHaveBeenCalledWith(conn, 'uname -sm')
  })

  it('reports progress via callback', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('Linux x86_64')
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
    mockExecCommand.mockResolvedValueOnce('Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    mockExecCommand.mockResolvedValueOnce('DEAD')
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn)

    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('defaults fresh relays to the three-hour SSH disconnect grace window', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('Linux x86_64')
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
    mockExecCommand.mockResolvedValueOnce('Linux x86_64')
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
    mockExecCommand.mockResolvedValueOnce('Linux x86_64')
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
    mockExecCommand.mockResolvedValueOnce('Linux x86_64')
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
      .mockResolvedValueOnce('Linux x86_64') // uname A
      .mockResolvedValueOnce('/home/user') // $HOME A
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe A
      .mockResolvedValueOnce('DEAD') // probe A
      .mockResolvedValueOnce('READY') // poll A
      .mockResolvedValueOnce('Linux x86_64') // uname B
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
      .mockRejectedValueOnce(new Error('uname not found')) // uname -sm
      .mockResolvedValueOnce('Windows X64') // PowerShell platform probe
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
      .mockRejectedValueOnce(new Error('uname not found')) // uname -sm
      .mockResolvedValueOnce('Windows X64') // PowerShell platform probe
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
      .mockRejectedValueOnce(new Error('uname not found')) // uname -sm
      .mockResolvedValueOnce('Windows X64') // PowerShell platform probe
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
      .mockRejectedValueOnce(new Error('uname not found')) // uname A
      .mockResolvedValueOnce('Windows X64')
      .mockResolvedValueOnce('C:\\Users\\me user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('') // no persisted active pipe A
      .mockResolvedValueOnce('WAITING')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('READY')
      .mockResolvedValueOnce('') // persist active pipe A
      .mockRejectedValueOnce(new Error('uname not found')) // uname B
      .mockResolvedValueOnce('Windows X64')
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
