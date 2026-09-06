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
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { finalizeInstall, isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import {
  BOTH_NATIVE_DEPS_MISSING_PROBE,
  decodePowerShellCommand,
  makeMockConnection,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'

// Stdout of the relay-side pty-master cloexec patch, which runs on Linux hosts once a
// freshly installed node-pty loads (#17915).
const NPTY_CLOEXEC_PATCHED = 'ORCA-NPTY-CLOEXEC:patched\n'
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
    // Why: the wrongful rebuild used to be the only visible symptom of a dropped exec channel.
    expect(
      warnings().some((message) => message.includes('Native deps probe unanswered')),
      'an unanswered probe must still leave a trace'
    ).toBe(true)
    expect(commands.some((command) => command.includes(NODE_PTY_RESET))).toBe(false)
    expect(commands.some((command) => command.includes(WATCHER_RESET))).toBe(false)
    expect(commands.some((command) => command.includes('npm install'))).toBe(false)
    // Exactly one probe: an unverifiable answer must not fall through to the locked re-probe.
    expect(commands.filter((command) => command.includes('ORCA-NATIVE-DEPS-OK'))).toHaveLength(1)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(outcome, 'lost contact must not abort the connection').not.toBeInstanceOf(Error)
  })

  it('leaves node_modules intact when the probe answers without naming a dep', async () => {
    // The bare `MISSING` a `|| echo MISSING` subshell emits when node never reached the script
    // (bad NODE_OPTIONS, OOM kill, exit 127). The shell answered; the answer is not about the deps.
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      'MISSING', // answered, no marker line: nothing here names a dep
      '', // launch namespace marker
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

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
    // One probe only: an unverifiable answer must not fall through to the locked re-probe.
    expect(commands.filter((command) => command.includes('ORCA-NATIVE-DEPS-OK'))).toHaveLength(1)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(outcome, 'an unparseable answer must not abort the connection').not.toBeInstanceOf(Error)
    expect(warnings().some((message) => message.includes('NATIVE-DEPS-PROBE-UNPARSEABLE'))).toBe(
      true
    )
  })

  it('carries the probe stderr into the unparseable-answer warning', async () => {
    const conn = makeMockConnection(sftpCapture)
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/u')
      .mockImplementationOnce((_conn, _command, options) => {
        options?.onStderr?.('node: --inspect-brk is not allowed in NODE_OPTIONS')
        return Promise.resolve('MISSING')
      })
    feed(['', 'DEAD', '', 'READY'])

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    // Why: `2>/dev/null` used to drop the one line that says which host config broke node.
    expect(
      warnings().find((message) => message.includes('NATIVE-DEPS-PROBE-UNPARSEABLE'))
    ).toContain('not allowed in NODE_OPTIONS')
  })

  it('still resets both deps when the probe names both', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      BOTH_NATIVE_DEPS_MISSING_PROBE, // answered: both deps are genuinely broken
      BOTH_NATIVE_DEPS_MISSING_PROBE, // re-probe under the repair lock
      '', // SFTP-namespace install-owner marker (repair)
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      NPTY_CLOEXEC_PATCHED,
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

  it('leaves a Windows relay intact when its probe answers without naming a dep', async () => {
    // The PowerShell branch has the same hole: `try { & node -e ... } catch { 'MISSING' }` prints
    // nothing when node exits non-zero without reaching the script.
    vi.mocked(parseUnameToRelayPlatform).mockReturnValueOnce('win32-x64')
    vi.mocked(resolveRemoteNodePath).mockResolvedValueOnce('C:/Program Files/nodejs/node.exe')
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Windows AMD64',
      'C:\\Users\\u',
      '', // health probe: PowerShell swallowed the native failure, so nothing names a dep
      '', // no persisted active pipe marker
      'WAITING', // initial pipe probe
      '', // publish the per-launch credential
      '', // WMI relay launch
      'READY', // readiness poll
      '' // persist active pipe marker
    ])

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    const scripts = execCommands().map((command) => decodePowerShellCommand(command) ?? command)
    expect(scripts.some((script) => script.includes('node_modules/node-pty'))).toBe(false)
    expect(scripts.some((script) => script.includes('node_modules/@parcel/watcher'))).toBe(false)
    expect(scripts.some((script) => script.includes('npm install'))).toBe(false)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(warnings().some((message) => message.includes('NATIVE-DEPS-PROBE-UNPARSEABLE'))).toBe(
      true
    )
  })

  it('resets only the dep the probe names', async () => {
    const conn = makeMockConnection(sftpCapture)
    const watcherMissing = 'ORCA-NATIVE-DEPS-MISSING:@parcel/watcher\nMISSING'
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      watcherMissing,
      watcherMissing, // re-probe under the repair lock
      '', // SFTP-namespace install-owner marker (repair)
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      NPTY_CLOEXEC_PATCHED,
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    const install = execCommands().find((command) => command.includes('npm install')) ?? ''
    expect(install).toContain(WATCHER_RESET)
    expect(install).not.toContain(NODE_PTY_RESET)
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
      NPTY_CLOEXEC_PATCHED,
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
