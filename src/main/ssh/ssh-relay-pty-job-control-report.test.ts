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
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { parseUnameToRelayPlatform } from './relay-protocol'
import { isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
import {
  makeExecResponses,
  makeMockConnection,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'

/**
 * The three job-object symbols never reach a remote: they come from Orca's
 * local node-pty patch, and the relay installs the stock registry package.
 * Before this probe the deploy log for such a host was byte-identical to one
 * where job control works, so nothing an operator could read told them apart.
 *
 * These specs pin the report, not a behaviour change: a relay without the
 * symbols still deploys, still launches, and still tears PTYs down the same way.
 */
describe('relay pty job-control reporting', () => {
  const sftpCapture: SftpWriteCapture = {
    paths: [],
    contents: {},
    execCallCountAtWrite: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(false)
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValue('acquired')
    sftpCapture.paths.length = 0
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

  async function deployWithProbeStdout(
    probeStdoutOverride: string
  ): Promise<{ support: string | undefined; log: string[] }> {
    const logged: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    try {
      const conn = makeMockConnection(sftpCapture)
      feed(makeExecResponses({ npmInstall: 'ok', probeStdoutOverride }))
      const result = await deployAndLaunchRelay(conn)
      return { support: result.ptyJobControl, log: logged }
    } finally {
      spy.mockRestore()
    }
  }

  function jobControlLine(log: string[]): string {
    return log.find((line) => line.includes('Remote node-pty job control')) ?? ''
  }

  it('asks the remote for all three job symbols in the native-deps probe', async () => {
    const { support } = await deployWithProbeStdout(
      'ORCA-NPTY-PROBE-OK\nORCA-PTY-JOB-CONTROL:present\n'
    )
    expect(support).toBe('present')
    const probeCommand =
      vi
        .mocked(execCommand)
        .mock.calls.map(([, command]) => command)
        .find((command) => command.includes('ORCA-NPTY-PROBE-OK')) ?? ''
    expect(probeCommand).toContain('ORCA-PTY-JOB-CONTROL:')
    expect(probeCommand).toContain('assignCurrentProcessToJob')
    expect(probeCommand).toContain('terminateJob')
    expect(probeCommand).toContain('listJobProcessIds')
  })

  it('reports present when the remote node-pty exposes the symbols', async () => {
    const { support, log } = await deployWithProbeStdout(
      'ORCA-NPTY-PROBE-OK\nORCA-PTY-JOB-CONTROL:present\n'
    )
    expect(support).toBe('present')
    expect(jobControlLine(log)).toContain('present')
  })

  it('reports absent when the remote node-pty is the stock package', async () => {
    const { support, log } = await deployWithProbeStdout(
      'ORCA-NPTY-PROBE-OK\nORCA-PTY-JOB-CONTROL:absent\n'
    )
    expect(support).toBe('absent')
    // The operator has to be able to tell this apart from a working relay.
    expect(jobControlLine(log)).toContain('absent')
    expect(jobControlLine(log)).not.toContain('unknown')
  })

  it('reports unknown, not absent, when the probe could not look', async () => {
    const { support, log } = await deployWithProbeStdout(
      'ORCA-NPTY-PROBE-OK\nORCA-PTY-JOB-CONTROL:unknown\n'
    )
    expect(support).toBe('unknown')
    expect(jobControlLine(log)).toContain('not a confirmed absence')
  })

  it('reports unknown, not absent, for a relay whose probe answers nothing', async () => {
    // An older relay predating the marker answers the deps probe and says nothing else.
    const { support, log } = await deployWithProbeStdout('ORCA-NPTY-PROBE-OK\n')
    expect(support).toBe('unknown')
    expect(jobControlLine(log)).toContain('not a confirmed absence')
  })

  async function deployReconnectWithHealthProbe(
    healthProbe: ExecResponse
  ): Promise<string | undefined> {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValue('busy')
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      healthProbe,
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])
    const result = await deployAndLaunchRelay(conn)
    return result.ptyJobControl
  }

  it('reports unknown when the probe command itself fails on a reconnect', async () => {
    await expect(
      deployReconnectWithHealthProbe({ reject: 'cd: no such file or directory' })
    ).resolves.toBe('unknown')
  })

  it('reports unknown, not the pre-repair verdict, when a repair aborts mid-flight', async () => {
    // The repair mutated the dir and then failed, so the verdict measured before it is stale.
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    const brokenWithVerdict =
      'ORCA-NATIVE-DEPS-MISSING:@parcel/watcher\nMISSING\nORCA-PTY-JOB-CONTROL:absent'
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      brokenWithVerdict, // health probe before the lock
      brokenWithVerdict, // re-probe under the lock
      '', // SFTP-namespace install-owner marker (repair)
      { reject: 'npm ERR! network ETIMEDOUT' },
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    const result = await deployAndLaunchRelay(conn)

    expect(result.ptyJobControl).toBe('unknown')
  })

  it('still reports a real absence on that same reconnect path', async () => {
    // Control for the case above: the path is not hardwired to 'unknown'.
    await expect(
      deployReconnectWithHealthProbe('ORCA-NATIVE-DEPS-OK\nORCA-PTY-JOB-CONTROL:absent\n')
    ).resolves.toBe('absent')
  })
})
