import { describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-opencode-runtime', () => ({
  ensureRemoteOpenCodeRuntime: vi.fn().mockResolvedValue('ready')
}))
vi.mock('./ssh-relay-ripgrep-install', () => ({
  remoteRipgrepLayout: vi.fn().mockReturnValue(null),
  recordRemoteRipgrepReference: vi.fn().mockResolvedValue(false),
  ensureRemoteBundledRipgrep: vi.fn().mockResolvedValue(undefined)
}))

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

import {
  parseShortRelaySocketDir,
  remoteSocketPathFitsLimit,
  remoteUnixSocketPathByteLimit,
  shortRelayVersionSegment
} from './relay-socket-path-limit'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const LINUX = getRemoteHostPlatform('linux-x64')
const DARWIN = getRemoteHostPlatform('darwin-arm64')
const WINDOWS = getRemoteHostPlatform('win32-x64')

/** Matches the version this suite's mocked build reports. */
const RELAY_VERSION_DIR_NAME = 'relay-0.1.0+8d4e15ad63eb'

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
