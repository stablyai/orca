// Why: the repair path used to map ANY probe failure to "all deps missing", so one dropped exec
// channel rm -rf'd node-pty on a healthy relay and forced a node-gyp rebuild. Verdicts are
// ok / blocked / unverifiable — see docs/reference/ssh-execution-boundary.md.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RelayInstallMarkerModule from './ssh-relay-install-marker'

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

vi.mock('./ssh-relay-install-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayInstallMarkerModule>()),
  createRelayInstallMarkerFileName: () => '.sftp-namespace-00000000000000000000000000000000'
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+testhash'),
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

vi.mock('./ssh-relay-gc-claim', () => ({
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('launch-token'),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, uploadDirectory } from './ssh-relay-deploy-helpers'
import { parseUnameToRelayPlatform } from './relay-protocol'
import { finalizeInstall, isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import {
  makeMockConnection,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'

const NODE_PTY_RESET = "rm -rf 'node_modules/node-pty'"
const WATCHER_RESET = "rm -rf 'node_modules/@parcel/watcher'"

describe('native-deps repair probe verdicts', () => {
  const sftpCapture: SftpWriteCapture = { paths: [], contents: {}, execCallCountAtWrite: {} }
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    vi.mocked(uploadDirectory).mockResolvedValue(undefined)
    sftpCapture.paths.length = 0
    for (const key of Object.keys(sftpCapture.contents)) {
      delete sftpCapture.contents[key]
    }
    for (const key of Object.keys(sftpCapture.execCallCountAtWrite)) {
      delete sftpCapture.execCallCountAtWrite[key]
    }
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  function feed(execResponses: ExecResponse[]): void {
    const mockExec = vi.mocked(execCommand)
    for (const response of execResponses) {
      if (typeof response === 'string') {
        mockExec.mockResolvedValueOnce(response)
      } else {
        mockExec.mockRejectedValueOnce(new Error(response.reject))
      }
    }
  }

  function execCommands(): string[] {
    return vi.mocked(execCommand).mock.calls.map(([, command]) => command)
  }

  function warnings(): string[] {
    return warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
  }

  it('launches an intact relay when the health probe never answers', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      { reject: 'SSH channel closed unexpectedly' }, // health probe: unverifiable, not MISSING
      '', // launch namespace marker
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    // Assert the repair-avoidance facts before the launch outcome so a regression names the defect
    // rather than the fixture drift that follows from an unexpected repair.
    const outcome = await deployAndLaunchRelay(conn).then(
      (result) => result,
      (err: Error) => err
    )

    const commands = execCommands()
    expect(warnings().some((message) => message.includes('Repairing missing native deps'))).toBe(
      false
    )
    expect(commands.some((command) => command.includes(NODE_PTY_RESET))).toBe(false)
    expect(commands.some((command) => command.includes(WATCHER_RESET))).toBe(false)
    expect(commands.some((command) => command.includes('npm install'))).toBe(false)
    // Exactly one probe: an unverifiable answer must not fall through to the locked re-probe.
    expect(commands.filter((command) => command.includes('ORCA-NATIVE-DEPS-OK'))).toHaveLength(1)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(outcome, 'lost contact must not abort the connection').not.toBeInstanceOf(Error)
  })

  it('still resets and repairs when the probe answers without the OK marker', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      'MISSING', // answered, no marker line: both deps are genuinely broken
      'MISSING', // re-probe under the repair lock
      '', // SFTP-namespace install-owner marker (repair)
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    const install = execCommands().find((command) => command.includes('npm install')) ?? ''
    expect(install).toContain(NODE_PTY_RESET)
    expect(install).toContain(WATCHER_RESET)
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
  })

  it('skips repair entirely when the probe answers OK', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      'ORCA-NATIVE-DEPS-OK',
      '', // launch namespace marker
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    expect(execCommands().some((command) => command.includes('npm install'))).toBe(false)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
  })

  it('keeps the answered reset scope when the locked re-probe cannot answer', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      'ORCA-NATIVE-DEPS-MISSING:@parcel/watcher\nMISSING', // answered: only the watcher is broken
      { reject: 'SSH channel closed unexpectedly' }, // re-probe under the lock: unverifiable
      '', // SFTP-namespace install-owner marker (repair)
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    const install = execCommands().find((command) => command.includes('npm install')) ?? ''
    expect(install).toContain(WATCHER_RESET)
    // The unanswered re-probe must not widen the reset to a dep no probe ever reported broken.
    expect(install).not.toContain(NODE_PTY_RESET)
  })
})
