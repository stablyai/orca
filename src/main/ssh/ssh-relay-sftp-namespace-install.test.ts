// Why: on a split-namespace host (Synology DSM) the shell path and the SFTP path
// name the same directory differently, so the deploy must keep issuing shell
// commands against the canonical path while every SFTP write is redirected — and
// only when this connection's own install marker proves the candidate is ours.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+testhash')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
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
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+testhash'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(false),
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

vi.mock('./ssh-relay-gc-claim', () => ({
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('launch-token'),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`,
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), {
      name: 'AbortError'
    })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, uploadDirectory } from './ssh-relay-deploy-helpers'
import { RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import { parseUnameToRelayPlatform } from './relay-protocol'
import {
  abandonInstall,
  finalizeInstall,
  isRelayAlreadyInstalled
} from './ssh-relay-versioned-install'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
import type { SshConnection } from './ssh-connection'
import type { SftpNamespacePathMapping } from './sftp-namespace-resolution'

// The transfer-option slice these tests inspect; SshConnection keeps its own options type internal.
type TransferOptions = { sftpNamespace?: SftpNamespacePathMapping }

const SHELL_HOME = '/home/u'
const SFTP_HOME = '/homes/u'
const RELAY_SUFFIX = '.orca-remote/relay-0.1.0+testhash'
const SHELL_RELAY_DIR = `${SHELL_HOME}/${RELAY_SUFFIX}`
const SFTP_RELAY_DIR = `${SFTP_HOME}/${RELAY_SUFFIX}`
const MARKER_PATTERN = /\.sftp-namespace-[0-9a-f]{32}/

type ConnectionOptions = {
  // '/homes/u' models a DSM host whose SFTP subsystem starts outside the shell home.
  sftpStartPath?: string
  lstatPresent?: (path: string) => boolean
  hangRealpath?: boolean
  // Models an SFTP session that never confirms close, so teardown stays unconfirmed.
  neverCloses?: boolean
  systemSsh?: boolean
  // Present only on the shipping path; absent doubles exercise the deploy's own SFTP fallback.
  transferMethods?: boolean
}

type Capture = {
  writePaths: string[]
  uploadTargets: string[]
  realpathCalls: string[]
  lstatCalls: string[]
  sftpEndCalls: number
  uploadOptions: (TransferOptions | undefined)[]
  writeOptions: (TransferOptions | undefined)[]
}

function newCapture(): Capture {
  return {
    writePaths: [],
    uploadTargets: [],
    realpathCalls: [],
    lstatCalls: [],
    sftpEndCalls: 0,
    uploadOptions: [],
    writeOptions: []
  }
}

// The marker this run created, read back from the shell command that made it.
function issuedMarkerName(): string | undefined {
  for (const [, command] of vi.mocked(execCommand).mock.calls) {
    const match = decodeCommand(command).match(MARKER_PATTERN)
    if (match) {
      return match[0]
    }
  }
  return undefined
}

function decodeCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : command
}

function execCommands(): string[] {
  return vi.mocked(execCommand).mock.calls.map(([, command]) => decodeCommand(command))
}

function makeConnection(capture: Capture, options: ConnectionOptions = {}): SshConnection {
  const startPath = options.sftpStartPath ?? SFTP_HOME
  // Default: the marker is visible only through the SFTP namespace, and only under this install's token.
  const lstatPresent =
    options.lstatPresent ??
    ((path: string) =>
      path.startsWith(`${SFTP_HOME}/`) && path.includes(issuedMarkerName() ?? '\0'))

  const makeSftp = (): unknown => {
    const sftp = new EventEmitter()
    return Object.assign(sftp, {
      mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
      realpath: vi.fn((path: string, cb: (err: Error | null, resolved?: string) => void) => {
        capture.realpathCalls.push(path)
        if (options.hangRealpath) {
          return
        }
        cb(null, startPath)
      }),
      lstat: vi.fn((path: string, cb: (err: Error | null) => void) => {
        capture.lstatCalls.push(path)
        cb(lstatPresent(path) ? null : Object.assign(new Error('No such file'), { code: 2 }))
      }),
      createWriteStream: vi.fn().mockImplementation((path: string) => {
        capture.writePaths.push(path)
        const ws = new EventEmitter()
        return Object.assign(ws, {
          end: vi.fn(() => setTimeout(() => ws.emit('close'), 0))
        })
      }),
      end: vi.fn(() => {
        capture.sftpEndCalls += 1
        if (!options.neverCloses) {
          setTimeout(() => sftp.emit('close'), 0)
        }
      })
    })
  }

  const conn: Record<string, unknown> = {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(false),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    sftp: vi.fn().mockImplementation(() => Promise.resolve(makeSftp()))
  }
  if (options.systemSsh) {
    conn.usesSystemSshTransport = vi.fn().mockReturnValue(true)
  }
  if (options.transferMethods) {
    conn.uploadDirectory = vi
      .fn()
      .mockImplementation((_local: string, remote: string, opts?: TransferOptions) => {
        capture.uploadTargets.push(remote)
        capture.uploadOptions.push(opts)
        return Promise.resolve()
      })
    conn.writeFile = vi
      .fn()
      .mockImplementation((remote: string, _contents: string, opts?: TransferOptions) => {
        capture.writePaths.push(remote)
        capture.writeOptions.push(opts)
        return Promise.resolve()
      })
  }
  return conn as unknown as SshConnection
}

function feed(responses: string[]): void {
  for (const response of responses) {
    vi.mocked(execCommand).mockResolvedValueOnce(response)
  }
}

// POSIX first install, healthy npm install and node-pty probe.
const POSIX_FIRST_INSTALL = [
  '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
  SHELL_HOME,
  '', // mkdir remoteDir (+ install-owner marker)
  '', // chmod +x node
  '', // npm install native deps
  '', // chmod prebuilds
  'ORCA-NPTY-PROBE-OK\n',
  '', // rm probe stderr
  'DEAD',
  'READY'
]

// POSIX repair of an installed dir whose native deps are missing.
const POSIX_REPAIR = [
  '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
  SHELL_HOME,
  'MISSING', // probe before the repair lock
  'MISSING', // re-probe under the lock
  '', // install-owner marker
  '', // npm install native deps
  '', // chmod prebuilds
  'ORCA-NPTY-PROBE-OK\n',
  '', // rm probe stderr
  'DEAD',
  'READY'
]

describe('relay install writes on a split SFTP namespace', () => {
  let capture: Capture
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset()
    vi.mocked(uploadDirectory).mockImplementation((_sftp, _local, remote: string) => {
      capture.uploadTargets.push(remote)
      return Promise.resolve()
    })
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(false)
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValue('acquired')
    capture = newCapture()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('redirects every first-install write while shell commands keep the canonical path', async () => {
    const conn = makeConnection(capture)
    feed(POSIX_FIRST_INSTALL)

    await deployAndLaunchRelay(conn)

    expect(capture.uploadTargets).toEqual([SFTP_RELAY_DIR])
    expect(capture.writePaths).toEqual([
      `${SFTP_RELAY_DIR}/.version`,
      `${SFTP_RELAY_DIR}/package.json`
    ])
    // Every shell command — mkdir, chmod, npm, launch — still names the shell path.
    for (const command of execCommands()) {
      expect(command).not.toContain(SFTP_RELAY_DIR)
    }
    expect(execCommands().some((command) => command.includes(SHELL_RELAY_DIR))).toBe(true)
  })

  it('folds the install-owner marker into the first-install mkdir', async () => {
    const conn = makeConnection(capture)
    feed(POSIX_FIRST_INSTALL)

    await deployAndLaunchRelay(conn)

    const markerCommands = execCommands().filter((command) => MARKER_PATTERN.test(command))
    expect(markerCommands).toHaveLength(1)
    expect(markerCommands[0]).toContain('mkdir')
    expect(markerCommands[0]).toContain(`${SHELL_RELAY_DIR}/.install-lock`)
  })

  it('probes one shared marker for every write of an install', async () => {
    const conn = makeConnection(capture)
    feed(POSIX_FIRST_INSTALL)

    await deployAndLaunchRelay(conn)

    const marker = issuedMarkerName()
    expect(marker).toMatch(MARKER_PATTERN)
    expect(capture.lstatCalls).toEqual([
      `${SHELL_RELAY_DIR}/.install-lock/${marker}`,
      `${SFTP_RELAY_DIR}/.install-lock/${marker}`,
      `${SHELL_RELAY_DIR}/.install-lock/${marker}`,
      `${SFTP_RELAY_DIR}/.install-lock/${marker}`,
      `${SHELL_RELAY_DIR}/.install-lock/${marker}`,
      `${SFTP_RELAY_DIR}/.install-lock/${marker}`
    ])
  })

  it('refuses a same-version candidate dir that carries another install marker', async () => {
    const foreign = `.sftp-namespace-${'f'.repeat(32)}`
    const conn = makeConnection(capture, {
      lstatPresent: (path) => path.startsWith(`${SFTP_HOME}/`) && path.includes(foreign)
    })
    feed(POSIX_FIRST_INSTALL)

    await deployAndLaunchRelay(conn)

    expect(capture.uploadTargets).toEqual([SHELL_RELAY_DIR])
    expect(capture.writePaths).toEqual([
      `${SHELL_RELAY_DIR}/.version`,
      `${SHELL_RELAY_DIR}/package.json`
    ])
  })

  it('keeps the shell path and skips probing when both namespaces agree', async () => {
    const conn = makeConnection(capture, { sftpStartPath: SHELL_HOME })
    feed(POSIX_FIRST_INSTALL)

    await deployAndLaunchRelay(conn)

    expect(capture.uploadTargets).toEqual([SHELL_RELAY_DIR])
    expect(capture.lstatCalls).toEqual([])
  })

  it('resolves against a start directory outside any home', async () => {
    const conn = makeConnection(capture, {
      sftpStartPath: '/volume1/shared',
      lstatPresent: (path) => path.startsWith('/volume1/shared/')
    })
    feed(POSIX_FIRST_INSTALL)

    await deployAndLaunchRelay(conn)

    expect(capture.uploadTargets).toEqual([`/volume1/shared/${RELAY_SUFFIX}`])
  })

  it('passes the same mapping to a connection that owns its own transfer methods', async () => {
    const conn = makeConnection(capture, { transferMethods: true })
    feed(POSIX_FIRST_INSTALL)

    await deployAndLaunchRelay(conn)

    // The shipping path hands over shell paths plus a mapping; resolution happens on the write session.
    expect(capture.uploadTargets).toEqual([SHELL_RELAY_DIR])
    expect(capture.writePaths).toEqual([
      `${SHELL_RELAY_DIR}/.version`,
      `${SHELL_RELAY_DIR}/package.json`
    ])
    const marker = issuedMarkerName()
    const mappings = [...capture.uploadOptions, ...capture.writeOptions].map(
      (options) => options?.sftpNamespace
    )
    expect(mappings).toHaveLength(3)
    for (const mapping of mappings) {
      expect(mapping?.shellProbePath).toBe(`${SHELL_RELAY_DIR}/.install-lock/${marker}`)
      expect(mapping?.homeRelativeProbePath).toBe(`${RELAY_SUFFIX}/.install-lock/${marker}`)
    }
    expect(mappings.map((mapping) => mapping?.homeRelativePath)).toEqual([
      RELAY_SUFFIX,
      `${RELAY_SUFFIX}/.version`,
      `${RELAY_SUFFIX}/package.json`
    ])
    expect(capture.realpathCalls).toEqual([])
  })

  it('leaves system-SSH connections unmapped and unprobed', async () => {
    // transferMethods models the shipping SshConnection path (uploadDirectory/writeFile → system SSH helpers).
    const conn = makeConnection(capture, { systemSsh: true, transferMethods: true })
    feed(POSIX_FIRST_INSTALL)

    await deployAndLaunchRelay(conn)

    expect(execCommands().some((command) => MARKER_PATTERN.test(command))).toBe(false)
    expect(capture.realpathCalls).toEqual([])
    expect(capture.lstatCalls).toEqual([])
    expect(conn.sftp).not.toHaveBeenCalled()
    // System SSH never retargets: shell absolute paths, no mapping, no SFTP session.
    expect(capture.uploadTargets).toEqual([SHELL_RELAY_DIR])
    expect(capture.writePaths).toEqual([
      `${SHELL_RELAY_DIR}/.version`,
      `${SHELL_RELAY_DIR}/package.json`
    ])
    const transferOptions = [...capture.uploadOptions, ...capture.writeOptions]
    expect(transferOptions).toHaveLength(3)
    for (const options of transferOptions) {
      expect(options?.sftpNamespace).toBeUndefined()
    }
  })

  it('leaves Windows hosts unmapped and unprobed', async () => {
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('win32-x64')
    const conn = makeConnection(capture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Windows AMD64',
      'C:\\Users\\u',
      '' // mkdir remoteDir
    ])
    // Fail the install right after the package.json write; the launch path is not what this asserts.
    vi.mocked(execCommand).mockRejectedValueOnce(new Error('npm install failed'))

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow('npm install failed')

    expect(execCommands().some((command) => MARKER_PATTERN.test(command))).toBe(false)
    expect(capture.realpathCalls).toEqual([])
    expect(capture.writePaths).toEqual([
      'C:/Users/u/.orca-remote/relay-0.1.0+testhash/.version',
      'C:/Users/u/.orca-remote/relay-0.1.0+testhash/package.json'
    ])
  })

  it('releases the first-install lock when a redirected upload fails', async () => {
    const conn = makeConnection(capture)
    feed(POSIX_FIRST_INSTALL)
    vi.mocked(uploadDirectory).mockRejectedValueOnce(new Error('sftp write failed'))

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow('sftp write failed')

    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
  })

  it('ends the SFTP session once when a deploy abort strands namespace discovery', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeConnection(capture, { hangRealpath: true })
      feed(POSIX_FIRST_INSTALL)

      const deploy = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.waitFor(() => expect(capture.realpathCalls).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TIMEOUT_MS)
      const result = await deploy

      expect((result as Error).message).toContain('Relay deployment timed out')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(capture.sftpEndCalls).toBe(1)
      // A confirmed close releases the first-install lock and leaves the dir incomplete.
      expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains the first-install lock when the aborted SFTP session never closes', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeConnection(capture, { hangRealpath: true, neverCloses: true })
      feed(POSIX_FIRST_INSTALL)

      const deploy = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.waitFor(() => expect(capture.realpathCalls).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TIMEOUT_MS)
      await deploy
      await vi.advanceTimersByTimeAsync(5_000)

      expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
      expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('relay repair writes on a split SFTP namespace', () => {
  let capture: Capture
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset()
    vi.mocked(uploadDirectory).mockResolvedValue(undefined)
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValue('acquired')
    capture = newCapture()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('stamps the marker only after the locked recheck, then redirects package.json', async () => {
    const conn = makeConnection(capture)
    let execCountAtLock = -1
    vi.mocked(tryAcquireRelayRepairLock).mockImplementation(() => {
      execCountAtLock = vi.mocked(execCommand).mock.calls.length
      return Promise.resolve('acquired')
    })
    feed(POSIX_REPAIR)

    await deployAndLaunchRelay(conn)

    const commands = execCommands()
    const markerIndex = commands.findIndex((command) => MARKER_PATTERN.test(command))
    expect(markerIndex).toBeGreaterThan(execCountAtLock)
    // The re-probe under the lock is the last exec before the marker.
    expect(commands[markerIndex - 1]).toContain('loadNativeModule')
    expect(capture.writePaths).toEqual([`${SFTP_RELAY_DIR}/package.json`])
  })

  it('does not stamp a marker when repairing over system SSH', async () => {
    const conn = makeConnection(capture, { systemSsh: true, transferMethods: true })
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      SHELL_HOME,
      'MISSING',
      'MISSING',
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      'DEAD',
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    expect(execCommands().some((command) => MARKER_PATTERN.test(command))).toBe(false)
    expect(conn.sftp).not.toHaveBeenCalled()
    expect(capture.writePaths).toEqual([`${SHELL_RELAY_DIR}/package.json`])
    expect(capture.writeOptions).toEqual([expect.objectContaining({ sftpNamespace: undefined })])
  })

  it('degrades to shell paths when marker creation fails outright', async () => {
    const conn = makeConnection(capture)
    feed(['__ORCA_REMOTE_PLATFORM__ Linux x86_64', SHELL_HOME, 'MISSING', 'MISSING'])
    vi.mocked(execCommand).mockRejectedValueOnce(new Error('read-only file system'))
    feed([
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      'DEAD',
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    expect(capture.writePaths).toEqual([`${SHELL_RELAY_DIR}/package.json`])
    expect(capture.realpathCalls).toEqual([])
    expect(warnSpy.mock.calls.map((args) => String(args[0]))).toContainEqual(
      expect.stringContaining('SFTP namespace marker unavailable')
    )
  })

  it('keeps the repair lock when marker creation has unconfirmed termination', async () => {
    const conn = makeConnection(capture)
    feed(['__ORCA_REMOTE_PLATFORM__ Linux x86_64', SHELL_HOME, 'MISSING', 'MISSING'])
    vi.mocked(execCommand).mockRejectedValueOnce(
      Object.assign(new Error('marker teardown unconfirmed'), { sshChannelCloseConfirmed: false })
    )
    feed(['DEAD', 'READY'])

    await deployAndLaunchRelay(conn)

    // Repair is best-effort: the relay still launches, but nothing was written and no lock was released.
    expect(capture.writePaths).toEqual([])
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
    expect(warnSpy.mock.calls.map((args) => String(args[0]))).toContainEqual(
      expect.stringContaining('launching degraded')
    )
  })
})
