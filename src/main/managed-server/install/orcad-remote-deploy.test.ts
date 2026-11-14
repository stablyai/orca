import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as RecordFile from './orcad-remote-record-file'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('../../../shared/shell/launch/shell-argument-quoting', () => ({
  quotePosixShell: (s: string) => `'${s}'`
}))
vi.mock('./remote-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  isRelayInstallLockStale: vi.fn().mockResolvedValue(false),
  RemoteInstallLockBusyError: class extends Error {},
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./remote-install-transfers', () => ({
  uploadRemoteInstallDirectory: vi.fn().mockResolvedValue(undefined),
  writeRemoteInstallFile: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./orcad-remote-record-file', async (importOriginal) => ({
  ...(await importOriginal<typeof RecordFile>()),
  writeAtomicOrcadRemoteRecord: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./orcad-remote-node-runtime', () => ({
  ensureRemoteOrcadNodeRuntime: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./orcad-local-build-hash', () => ({
  computeLocalOrcadBuildHash: () => 'abc123def4567890'
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { isRelayInstallLockStale } from './remote-install-lock'
import { uploadRemoteInstallDirectory } from './remote-install-transfers'
import { writeAtomicOrcadRemoteRecord } from './orcad-remote-record-file'
import { deployOrcad, type OrcadDeployOptions } from './orcad-remote-deploy'
import { installOrcadBundle } from './orcad-remote-install'
import { finalizeInstall } from './remote-versioned-install'
import {
  emptyOrcadActivationRecord,
  withActivatedVersion
} from '../activation/orcad-activation-record'

import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { isReadinessRead } from '../activation/orcad-activation-host-test-harness'
import { isSnapshotCaptureCommand } from '../activation/testing/orcad-snapshot-capture-command'
import { NODE_RUNTIME_PIN } from '../../../shared/node-runtime-pin'
import { serializeOrcadActivationTransaction } from '../activation/orcad-activation-transaction'
import { createOrcadActivationTransaction } from '../activation/orcad-activation-transaction-transitions'

const mockExec = vi.mocked(execCommand)
const NEW_VERSION = '0.2.0+bb0100000000'
const OLD_VERSION = '0.1.0+aa01'

vi.mock('./remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalFullVersion: () => '0.2.0+bb0100000000',
  isRemoteInstallComplete: vi.fn().mockResolvedValue(false),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined)
}))

function readyLine(overrides: {
  version?: string
  buildHash?: string
  daemonState?: 'live' | 'degraded' | 'absent'
  selfTestOk?: boolean
}): string {
  return JSON.stringify({
    type: 'orca_server_ready',
    schemaVersion: 1,
    runtimeId: 'r1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
    health: {
      buildHash: overrides.buildHash ?? 'abc123def4567890',
      buildVersion: overrides.version ?? NEW_VERSION,
      nodeVersion: '20.11.0',
      nodeAbi: '115',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      terminalDaemon: {
        state: overrides.daemonState ?? 'live',
        ownsFreshSessions: (overrides.daemonState ?? 'live') === 'live',
        pid: 2,
        buildVersion: NEW_VERSION,
        entryPath: '/x/daemon-entry.js',
        protocolVersion: 3,
        selfTest: {
          ok: overrides.selfTestOk ?? true,
          coverage: 'pty-spawn',
          verdict: (overrides.selfTestOk ?? true) ? 'healthy' : 'pty-spawn-unhealthy',
          durationMs: 5
        }
      }
    }
  })
}

type HostScript = {
  activationRecord: string
  readiness: Record<string, string>
  log: string[]
  preflightResult?: string
  snapshotResult?: string
  comparisonResult?: string
  candidateStopResult?: string
  orcadLog?: string
}

function scriptHost(script: HostScript): void {
  mockExec.mockImplementation(async (_conn, command: string) => {
    const text = String(command)
    if (text.startsWith('tail -c')) {
      return script.orcadLog ?? ''
    }
    if (text.includes('__ORCAD_RECORD_PRESENT__') && text.includes('orcad-active.json')) {
      return script.activationRecord
        ? `__ORCAD_RECORD_PRESENT__\n${script.activationRecord}`
        : '__ORCAD_RECORD_ABSENT__\n'
    }
    if (text.includes('__ORCAD_RECORD_PRESENT__') && text.includes('transaction.json')) {
      return '__ORCAD_RECORD_ABSENT__\n'
    }
    if (text.includes('__ORCAD_BUILD_HASH__')) {
      return '__ORCAD_BUILD_HASH__ abc123def4567890\n'
    }
    if (text.includes('orcad.lock') && text.includes('orca-runtime.json')) {
      return 'CLEAR'
    }
    if (text.includes('.orcad-readiness') && isReadinessRead(text)) {
      const version = Object.keys(script.readiness).find((v) => text.includes(v))
      return version ? script.readiness[version] : ''
    }
    if (text.includes('--orcad-profile-state-preflight')) {
      script.log.push('preflight')
      return (
        script.preflightResult ??
        JSON.stringify({
          type: 'orca_profile_state_ready',
          nonce: text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0],
          runtime: 'node',
          runtimeVersion: NODE_RUNTIME_PIN.version,
          sqliteVersion: '3.51.0',
          artifactVersion: NEW_VERSION,
          revision: 1
        })
      )
    }
    if (text.includes('nohup')) {
      script.log.push(`launch:${text.includes(NEW_VERSION) ? NEW_VERSION : OLD_VERSION}`)
      return '9999'
    }
    if (text.includes('kill -TERM')) {
      script.log.push(`stop:${text.includes(NEW_VERSION) ? NEW_VERSION : OLD_VERSION}`)
      return text.includes(NEW_VERSION) ? (script.candidateStopResult ?? 'STOPPED') : 'STOPPED'
    }
    if (isSnapshotCaptureCommand(text)) {
      script.log.push('snapshot')
      return script.snapshotResult ?? 'CAPTURED'
    }
    if (text.includes('verdict=UNCHANGED')) {
      script.log.push('compare-state')
      return script.comparisonResult ?? 'UNCHANGED'
    }
    return ''
  })
}

function options(overrides: Partial<OrcadDeployOptions> = {}): OrcadDeployOptions {
  const census = overrides.census ?? {
    liveSessions: 0,
    startedSinceActivation: 0,
    daemonProtocolVersion: 3
  }
  return {
    conn: Object.create(null),
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/u',
    localOrcadDir: '/local/out/orcad',
    target: 'linux-x64-glibc',
    nodePath: '/usr/bin/node',
    userDataDir: '/home/u/.orca',
    bindHost: '127.0.0.1',
    port: 7777,
    census,
    // An unchanged recount unless a test opens a terminal during the upload.
    recountCensus: async () => census,
    releaseIncumbentAdmission: async () => {},
    readinessTimeoutMs: 50,
    sleep: async () => {},
    now: () => new Date('2026-02-02T00:00:00.000Z'),
    ...overrides
  }
}

const ACTIVE_OLD = JSON.stringify(
  withActivatedVersion(emptyOrcadActivationRecord(), OLD_VERSION, null, new Date(0))
)

describe('deployOrcad', () => {
  it.each(['', '{"type":"orca_profile_state_ready","revision":0}'])(
    'leaves the incumbent and shared state alone when preflight returns %j',
    async (preflightResult) => {
      const script: HostScript = {
        activationRecord: ACTIVE_OLD,
        readiness: { [NEW_VERSION]: readyLine({}) },
        log: [],
        preflightResult
      }
      scriptHost(script)
      expect(await deployOrcad(options())).toMatchObject({
        outcome: 'installed-not-activated',
        code: 'orcad_candidate_preflight_failed',
        startCheckFailed: true
      })
      expect(script.log).toEqual(['preflight'])
      expect(
        vi
          .mocked(writeAtomicOrcadRemoteRecord)
          .mock.calls.some(([, path]) => path.includes('orcad-active.json'))
      ).toBe(false)
    }
  )

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['a fresh fence with no journal', false, false, 'orcad_activation_fence_busy'],
    ['a stale fence over a journal', true, true, 'orcad_activation_recovery_required'],
    ['a fresh fence over a live run journal', false, true, 'orcad_activation_fence_busy']
  ])('refuses before uploading on %s', async (_label, stale, journal, code) => {
    vi.mocked(isRelayInstallLockStale).mockResolvedValueOnce(stale)
    const JOURNAL = serializeOrcadActivationTransaction(
      createOrcadActivationTransaction({
        transactionId: '00000000-0000-4000-8000-000000000001',
        candidateVersion: NEW_VERSION,
        recordBefore: emptyOrcadActivationRecord(),
        snapshotDirName: 'pre-1',
        now: new Date(0)
      })
    )
    mockExec.mockImplementation(async (_conn, command) => {
      const text = String(command)
      if (text.includes('echo LOCKED || echo OPEN')) {
        return 'LOCKED\n'
      }
      if (text.includes('__ORCAD_RECORD_ABSENT__') && text.includes('transaction.json')) {
        return journal ? `__ORCAD_RECORD_PRESENT__\n${JOURNAL}` : '__ORCAD_RECORD_ABSENT__\n'
      }
      return text.includes('__ORCAD_RECORD_ABSENT__') ? '__ORCAD_RECORD_ABSENT__\n' : ''
    })
    await expect(deployOrcad(options())).resolves.toMatchObject({
      outcome: 'installed-not-activated',
      code
    })
    expect(uploadRemoteInstallDirectory).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32').each([undefined, 'linux-x64', 'linux-musl-x64'])(
    'restores uploaded executable modes with optional browser %s',
    async (browserTarget) => {
      const directory = mkdtempSync(join(tmpdir(), 'orcad-install-modes-'))
      const binaries = ['ripgrep/linux-x64/rg']
      if (browserTarget) {
        binaries.push(`agent-browser-${browserTarget}`)
      }
      try {
        for (const filename of binaries) {
          const path = join(directory, filename)
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, 'uploaded executable')
          chmodSync(path, 0o644)
        }
        mockExec.mockImplementation(async (_conn, command) => {
          const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
          if (result.code !== 0) {
            throw new Error(result.stderr)
          }
          return result.stdout
        })
        await installOrcadBundle(
          {
            conn: options().conn,
            host: getRemoteHostPlatform('linux-x64'),
            localOrcadDir: directory,
            target: 'linux-x64-musl',
            nodeRuntimeArchive: async () => '/cache/node.tar.gz'
          },
          NEW_VERSION,
          directory
        )
        expect(finalizeInstall).toHaveBeenCalledOnce()
        for (const filename of binaries) {
          expect(statSync(join(directory, filename)).mode & 0o777).toBe(0o755)
        }
      } finally {
        mockExec.mockReset()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('activates a healthy candidate and records the outgoing version as the rollback target', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ outcome: 'installed-and-activated', fullVersion: NEW_VERSION })
    const written = vi
      .mocked(writeAtomicOrcadRemoteRecord)
      .mock.calls.find((call) => String(call[1]).endsWith('orcad-active.json'))
    expect(JSON.parse(String(written?.[2]))).toMatchObject({
      active: NEW_VERSION,
      previous: OLD_VERSION
    })
  })

  it('treats the census as unverifiable when another incumbent lands mid-upload', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    const counted = JSON.parse(ACTIVE_OLD)
    // A same-app-line peer activation passes version admission; census binding must catch the changed incumbent.
    const peer = withActivatedVersion(counted, '0.1.5+dd01', null, new Date(5), '1.4.0')
    vi.mocked(uploadRemoteInstallDirectory).mockImplementationOnce(async () => {
      script.activationRecord = JSON.stringify(peer)
    })
    expect(
      await deployOrcad(options({ censusRecord: counted, admitRecord: () => null }))
    ).toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_update_terminal_census_unavailable'
    })
    expect(script.log).toEqual([])
  })

  it('installs but does not activate when terminals are running', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(
      options({ census: { liveSessions: 2, startedSinceActivation: 0, daemonProtocolVersion: 3 } })
    )
    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_update_terminals_running',
      freshlyInstalled: true
    })
    // A deferral keeps its staged build for the later update.
    expect(result).not.toHaveProperty('startCheckFailed')
    // Uploading bytes must not mutate a refused incumbent.
    expect(vi.mocked(uploadRemoteInstallDirectory)).toHaveBeenCalled()
    expect(script.log).toEqual([])
  })

  it('does not write the activation record when the candidate fails its health gate', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({ daemonState: 'degraded' }) },
      log: [],
      orcadLog: 'daemon: starting\ndaemon: socket bind failed: EACCES\n'
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ code: 'orcad_activation_daemon_degraded' })
    // Report the candidate failure itself, not just its log path.
    expect(result).toMatchObject({
      reason: expect.stringMatching(/Last lines of orcad\.log:\ndaemon: starting\n.*EACCES$/u)
    })
    expect(
      vi
        .mocked(writeAtomicOrcadRemoteRecord)
        .mock.calls.some((call) => String(call[1]).endsWith('orcad-active.json'))
    ).toBe(false)
  })

  it('puts the previous version back after a rejected candidate, rather than leaving the host down', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({ selfTestOk: false }),
        [OLD_VERSION]: readyLine({ version: OLD_VERSION })
      },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ startCheckFailed: true, freshlyInstalled: true })
    expect(script.log).toEqual([
      'preflight',
      `stop:${OLD_VERSION}`,
      'snapshot',
      `launch:${NEW_VERSION}`,
      `stop:${NEW_VERSION}`,
      'compare-state',
      `launch:${OLD_VERSION}`
    ])
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      `orcad ${OLD_VERSION} was restarted and is serving again`
    )
  })

  it.each(['CHANGED', 'UNKNOWN', ''])(
    'preserves rejected candidate state when comparison is %s',
    async (comparisonResult) => {
      const script: HostScript = {
        activationRecord: ACTIVE_OLD,
        readiness: { [NEW_VERSION]: readyLine({ selfTestOk: false }) },
        log: [],
        comparisonResult
      }
      scriptHost(script)

      const result = await deployOrcad(options())

      expect(result).toMatchObject({ outcome: 'installed-not-activated' })
      expect(script.log).toEqual([
        'preflight',
        `stop:${OLD_VERSION}`,
        'snapshot',
        `launch:${NEW_VERSION}`,
        `stop:${NEW_VERSION}`,
        'compare-state'
      ])
      expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
        'Recover to restore the prelaunch snapshot'
      )
      expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
        '/home/u/.orca-remote/orcad-state-snapshots/'
      )
      expect(mockExec.mock.calls.some(([, command]) => command.includes('echo RESTORED'))).toBe(
        false
      )
    }
  )

  it('restarts the incumbent when a quiescent snapshot cannot be captured', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [OLD_VERSION]: readyLine({ version: OLD_VERSION }) },
      log: [],
      snapshotResult: 'SNAPSHOT_FAILURE tar: Cannot write: No space left on device\nFAILED'
    }
    scriptHost(script)

    await expect(deployOrcad(options())).rejects.toThrow(
      /activating \S+: tar: Cannot write: No space left on device\. .*incumbent was stopped/u
    )
    expect(script.log).toEqual([
      'preflight',
      `stop:${OLD_VERSION}`,
      'snapshot',
      `launch:${OLD_VERSION}`
    ])
  })

  it('refuses to activate when a different build answered the port', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({ buildHash: 'deadbeefdeadbeef' }),
        [OLD_VERSION]: readyLine({ version: OLD_VERSION })
      },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ code: 'orcad_activation_build_mismatch' })
  })

  it('refuses to treat an unreadable activation record as an empty one', async () => {
    const script: HostScript = {
      activationRecord: JSON.stringify({ schemaVersion: 99, active: 'x' }),
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    await expect(deployOrcad(options())).rejects.toThrow('activation record')
    expect(vi.mocked(uploadRemoteInstallDirectory)).not.toHaveBeenCalled()
  })
})
