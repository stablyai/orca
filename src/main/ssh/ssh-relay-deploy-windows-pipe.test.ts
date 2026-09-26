// Windows named-pipe endpoint deploys, split out of ssh-relay-deploy.test.ts: that file sits at
// the max-lines cap, and these four share only the deploy harness with the rest of it.
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

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
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
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import { acquireInstallLock } from './ssh-relay-install-lock'
import type { SshConnection } from './ssh-connection'

function decodePowerShellCommand(command: string): string | null {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : null
}

const extractWindowsSockPath = (script: string): string =>
  /--sock-path\s+'([^']+)'/.exec(script)?.[1] ?? ''

const extractWindowsMarkerPath = (script: string): string =>
  /-LiteralPath\s+'([^']*\.windows-active-pipe[^']*)'/.exec(script)?.[1] ?? ''

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

describe('deployAndLaunchRelay on Windows remotes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    vi.mocked(waitForSentinel).mockReset().mockResolvedValue({
      write: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn()
    })
    vi.mocked(resolveRemoteNodePath).mockReset().mockResolvedValue('/usr/bin/node')
    vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(true)
    vi.mocked(acquireInstallLock).mockReset().mockResolvedValue(undefined)
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
    expect(launchScript).toContain(
      '--ripgrep-path "C:/Users/me user/.orca-remote/ripgrep/c0ffee0123456789-win32-x64/rg.exe"'
    )
    expect(launchScript).not.toContain('--pty-source-credit-v1')
    expect(launchScript).not.toContain('.pty-source-credit-policy')
    expect(launchScript).not.toContain('\\\\.\\pipe\\agent-hooks')
    const waitScript = decodedScripts.find((script) => script.includes('deadline=Date.now()')) ?? ''
    expect(waitScript).toContain('setTimeout(attempt,intervalMs)')
    const windowsLaunchCalls = mockExecCommand.mock.calls.filter(([, command]) => {
      const script = decodePowerShellCommand(command)
      return (
        script?.includes('.windows-active-pipe') ||
        script?.includes('Invoke-CimMethod') ||
        script?.includes('deadline=Date.now()')
      )
    })
    expect(windowsLaunchCalls.length).toBeGreaterThan(0)
    expect(
      windowsLaunchCalls.every(([, , options]) => options?.signal instanceof AbortSignal)
    ).toBe(true)
    expect(vi.mocked(conn.exec).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(vi.mocked(waitForSentinel).mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
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
