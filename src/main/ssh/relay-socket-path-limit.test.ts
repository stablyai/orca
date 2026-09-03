import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn(() => 'linux-x64'),
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
  isUnconfirmedSshCommandTermination: () => false,
  execCommand: vi.fn().mockResolvedValue('')
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-endpoint-credential', () => ({
  writeRelayEndpointCredential: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+8d4e15ad63eb'),
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
    Object.assign(new Error('SSH operation was cancelled'), { name: 'AbortError' })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { forceStopRelayForTarget } from './ssh-relay-reset'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import {
  parseShortRelaySocketDir,
  remoteSocketPathFitsLimit,
  remoteUnixSocketPathByteLimit,
  shortRelayVersionSegment,
  SHORT_RELAY_SOCKET_DIR_PREFIX
} from './relay-socket-path-limit'
import { supersededRelayEndpointListCommand } from './ssh-relay-superseded-endpoints'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'

const LINUX = getRemoteHostPlatform('linux-x64')
const DARWIN = getRemoteHostPlatform('darwin-arm64')
const WINDOWS = getRemoteHostPlatform('win32-x64')

// The reporter's host: a managed-hosting container whose $HOME is 45 bytes (#10726).
const LONG_HOME = '/var/www/611f7cf9-f715-49e6-91d9-0ffac1d7c4c0'

/** Matches the version this suite's mocked build reports. */
const RELAY_VERSION_DIR_NAME = 'relay-0.1.0+8d4e15ad63eb'

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
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') {
            setTimeout(cb, 0)
          }
        }),
        end: vi.fn()
      }),
      end: vi.fn()
    })
  } as unknown as SshConnection
}

function launchedSockPath(conn: SshConnection): string {
  const launch = vi
    .mocked(conn.exec)
    .mock.calls.map(([command]) => command as string)
    .find((command) => command.includes('--detached'))
  return /--sock-path\s+'([^']+)'/.exec(launch ?? '')?.[1] ?? ''
}

describe('remote unix socket path limit', () => {
  it('uses the per-OS sun_path budget and ignores Windows named pipes', () => {
    expect(remoteUnixSocketPathByteLimit(LINUX)).toBe(107)
    expect(remoteUnixSocketPathByteLimit(DARWIN)).toBe(103)
    expect(remoteUnixSocketPathByteLimit(WINDOWS)).toBeNull()
    expect(remoteSocketPathFitsLimit(WINDOWS, `\\\\.\\pipe\\orca-relay-${'a'.repeat(400)}`)).toBe(
      true
    )
  })

  it('measures bytes, not characters', () => {
    // 1 + 52 two-byte characters = 105 bytes: fits Linux (107), not macOS (103).
    const path = `/${'é'.repeat(52)}`
    expect(path.length).toBe(53)
    expect(remoteSocketPathFitsLimit(LINUX, path)).toBe(true)
    expect(remoteSocketPathFitsLimit(DARWIN, path)).toBe(false)
  })

  it('accepts only the marker line as the short directory', () => {
    const segment = shortRelayVersionSegment(RELAY_VERSION_DIR_NAME)
    expect(
      parseShortRelaySocketDir(
        `Welcome to Ubuntu\nORCA-RELAY-SHORT-SOCKET-DIR /tmp/.orca-relay-1000/${segment}\n`,
        segment
      )
    ).toBe(`/tmp/.orca-relay-1000/${segment}`)
    expect(parseShortRelaySocketDir('mkdir: permission denied\n', segment)).toBeNull()
    expect(
      parseShortRelaySocketDir(`ORCA-RELAY-SHORT-SOCKET-DIR /etc/${segment}\n`, segment)
    ).toBeNull()
    // A directory belonging to another build must not be adopted as this build's.
    expect(
      parseShortRelaySocketDir(
        `ORCA-RELAY-SHORT-SOCKET-DIR /tmp/.orca-relay-1000/${shortRelayVersionSegment('relay-9.9.9+other')}\n`,
        segment
      )
    ).toBeNull()
  })
})

describe('relay launch with a long remote $HOME', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the launched socket path inside the remote sun_path limit', async () => {
    const conn = makeMockConnection()
    vi.mocked(execCommand)
      .mockReset()
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce(LONG_HOME)
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('') // launch namespace marker
      .mockResolvedValueOnce(
        `ORCA-RELAY-SHORT-SOCKET-DIR ${SHORT_RELAY_SOCKET_DIR_PREFIX}1000/${shortRelayVersionSegment(RELAY_VERSION_DIR_NAME)}`
      )
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('READY')
      .mockResolvedValue('')

    // A per-target relay instance id is what pushes the default path past the limit:
    // 45-byte $HOME + `/.orca-remote/relay-0.1.0+8d4e15ad63eb` + `/relay-<hash16>.sock` = 110 bytes.
    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'ssh-target-1')

    const sockPath = launchedSockPath(conn)
    expect(sockPath).not.toBe('')
    expect(Buffer.byteLength(sockPath, 'utf8')).toBeLessThanOrEqual(
      remoteUnixSocketPathByteLimit(LINUX) as number
    )
    expect(sockPath.startsWith(`${SHORT_RELAY_SOCKET_DIR_PREFIX}1000/`)).toBe(true)
    expect(result.sockPath).toBe(sockPath)
    // The hashed socket name survives intact, so two targets cannot collide -- and the
    // build's version segment sits above it, so the next Orca release binds a path of
    // its own instead of the one this relay is still holding.
    expect(sockPath).toBe(
      `${SHORT_RELAY_SOCKET_DIR_PREFIX}1000/${shortRelayVersionSegment(RELAY_VERSION_DIR_NAME)}/${relaySocketNameForInstanceId('ssh-target-1')}`
    )
    expect(shortRelayVersionSegment('relay-0.1.0+next')).not.toBe(
      shortRelayVersionSegment(RELAY_VERSION_DIR_NAME)
    )
  })

  it('sweeps superseded relays under the short base too, but never the live one', () => {
    const currentShortSocketDir = `${SHORT_RELAY_SOCKET_DIR_PREFIX}1000/${shortRelayVersionSegment(RELAY_VERSION_DIR_NAME)}`
    const script = supersededRelayEndpointListCommand({
      remoteHome: LONG_HOME,
      currentRelayDir: `${LONG_HOME}/.orca-remote/${RELAY_VERSION_DIR_NAME}`,
      sockName: relaySocketNameForInstanceId('ssh-target-1'),
      currentShortSocketDir
    })

    // A relocated orphan lives outside $HOME, so the sweep that exists to make orphans
    // visible has to look at the short base as well.
    expect(script).toContain(`short_base="${SHORT_RELAY_SOCKET_DIR_PREFIX}$(id -u 2>/dev/null)"`)
    expect(script).toContain('"$short_base"/relay-*/"$sock_name"')
    expect(script).toContain(`short_current='${currentShortSocketDir}'`)
    expect(script).toContain('[ -n "$short_current" ] && [ "$dir" = "$short_current" ] && continue')
  })

  it('leaves the socket in the versioned relay dir when it already fits', async () => {
    const conn = makeMockConnection()
    vi.mocked(execCommand)
      .mockReset()
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('READY')
      .mockResolvedValue('')

    await deployAndLaunchRelay(conn)

    expect(launchedSockPath(conn)).toBe(
      '/home/user/.orca-remote/relay-0.1.0+8d4e15ad63eb/relay.sock'
    )
  })

  it('force-stop also looks for the socket under the short base', async () => {
    const conn = makeMockConnection()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')

    await forceStopRelayForTarget(conn, 'ssh-1')

    const script = vi.mocked(execCommand).mock.calls[0]?.[1] as string
    expect(script).toContain(`short_base="${SHORT_RELAY_SOCKET_DIR_PREFIX}$(id -u 2>/dev/null)"`)
    expect(script).toContain('"$short_base"/relay-*/"$sock_name"')
  })
})
