import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as RecordFile from './orcad-remote-record-file'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: () => false
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  isRelayInstallLockStale: vi.fn().mockResolvedValue(false),
  RemoteInstallLockBusyError: class extends Error {},
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./ssh-relay-install-transfers', () => ({
  uploadRelayDirectory: vi.fn().mockResolvedValue(undefined),
  writeRelayFile: vi.fn().mockResolvedValue(undefined)
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

import { execCommand } from './ssh-relay-deploy-helpers'
import { acquireInstallLock, isRelayInstallLockStale } from './ssh-relay-install-lock'
import { uploadRelayDirectory } from './ssh-relay-install-transfers'
import { writeAtomicOrcadRemoteRecord } from './orcad-remote-record-file'
import { deployOrcad, type OrcadDeployOptions } from './orcad-remote-deploy'
import { installOrcadBundle } from './orcad-remote-install'
import { ensureRemoteOrcadNodeRuntime } from './orcad-remote-node-runtime'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './ssh-relay-versioned-install'
import { emptyOrcadActivationRecord, withActivatedVersion } from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { isReadinessRead } from './orcad-activation-host-test-harness'
import { isSnapshotCaptureCommand } from './orcad-snapshot-capture-command'
import type { SshConnection } from './ssh-connection'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import { serializeOrcadActivationTransaction } from './orcad-activation-transaction'
import { createOrcadActivationTransaction } from './orcad-activation-transaction-transitions'

const mockExec = vi.mocked(execCommand)
const NEW_VERSION = '0.2.0+bb0100000000'
const OLD_VERSION = '0.1.0+aa01'

vi.mock('./ssh-relay-versioned-install', async (importOriginal) => ({
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
  /** Readiness content per version dir, keyed by the version in the path. */
  readiness: Record<string, string>
  log: string[]
  preflightResult?: string
  snapshotResult?: string
  comparisonResult?: string
  candidateStopResult?: string
  readinessAtMs?: number
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
      if (script.readinessAtMs !== undefined && Date.now() < script.readinessAtMs) {
        return ''
      }
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
  return {
    conn: {} as SshConnection,
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/u',
    localOrcadDir: '/local/out/orcad',
    target: 'linux-x64-glibc',
    nodePath: '/usr/bin/node',
    userDataDir: '/home/u/.orca',
    bindHost: '127.0.0.1',
    port: 7777,
    census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 },
    readinessTimeoutMs: 50,
    sleep: async () => {},
    now: () => new Date('2026-02-02T00:00:00.000Z'),
    ...overrides
  }
}

const ACTIVE_OLD = JSON.stringify(
  withActivatedVersion(emptyOrcadActivationRecord(), OLD_VERSION, null, new Date(0))
)

describe('orcad install lock ownership', () => {
  const remoteDir = `/home/u/.orca-remote/orcad-${NEW_VERSION}`
  const install = (signal?: AbortSignal) =>
    installOrcadBundle(
      {
        ...options({ signal }),
        localOrcadDir: '/local/out/orcad',
        target: 'linux-x64-glibc',
        nodeRuntimeArchive: async () => '/cache/node.tar.gz'
      },
      NEW_VERSION,
      remoteDir
    )

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isRemoteInstallComplete).mockReset().mockResolvedValue(false)
  })

  it('leaves another install lock alone when the initial probe is complete', async () => {
    vi.mocked(isRemoteInstallComplete).mockResolvedValueOnce(true)
    await install()
    expect(acquireInstallLock).not.toHaveBeenCalled()
    expect(abandonInstall).not.toHaveBeenCalled()
    expect(uploadRelayDirectory).not.toHaveBeenCalled()
  })

  it('releases its lock when another installer completed while acquisition waited', async () => {
    vi.mocked(isRemoteInstallComplete).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await install()
    expect(acquireInstallLock).toHaveBeenCalledOnce()
    expect(abandonInstall).toHaveBeenCalledOnce()
    expect(abandonInstall).toHaveBeenCalledWith(expect.anything(), remoteDir, options().host)
    expect(uploadRelayDirectory).not.toHaveBeenCalled()
    expect(finalizeInstall).not.toHaveBeenCalled()
  })

  it('publishes a complete install before releasing its lock once', async () => {
    await install()
    expect(uploadRelayDirectory).toHaveBeenCalledOnce()
    expect(finalizeInstall).toHaveBeenCalledWith(expect.anything(), remoteDir, options().host, {
      signal: undefined,
      releaseLock: false
    })
    expect(abandonInstall).toHaveBeenCalledOnce()
    expect(vi.mocked(finalizeInstall).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(abandonInstall).mock.invocationCallOrder[0]
    )
  })

  it('releases a failed upload without publishing it or replacing its error', async () => {
    const error = new Error('upload interrupted')
    vi.mocked(uploadRelayDirectory).mockRejectedValueOnce(error)
    await expect(install()).rejects.toBe(error)
    expect(abandonInstall).toHaveBeenCalledOnce()
    expect(finalizeInstall).not.toHaveBeenCalled()
  })

  it('releases its lock without reusing an aborted operation signal', async () => {
    const controller = new AbortController()
    const error = new Error('deployment canceled')
    vi.mocked(uploadRelayDirectory).mockImplementationOnce(async () => {
      controller.abort(error)
      controller.signal.throwIfAborted()
    })
    await expect(install(controller.signal)).rejects.toBe(error)
    expect(abandonInstall).toHaveBeenCalledOnce()
    expect(abandonInstall).toHaveBeenCalledWith(expect.anything(), remoteDir, options().host)
    expect(finalizeInstall).not.toHaveBeenCalled()
  })

  it('does not release a lock when acquisition failed', async () => {
    const error = new Error('lock held by another client')
    vi.mocked(acquireInstallLock).mockRejectedValueOnce(error)
    await expect(install()).rejects.toBe(error)
    expect(abandonInstall).not.toHaveBeenCalled()
    expect(uploadRelayDirectory).not.toHaveBeenCalled()
  })
})

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
        code: 'orcad_candidate_preflight_failed'
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

  it('installs under the orcad namespace, not the relay one', async () => {
    const script: HostScript = {
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    await deployOrcad(options())
    expect(vi.mocked(acquireInstallLock).mock.calls[0][1]).toBe(
      `/home/u/.orca-remote/orcad-${NEW_VERSION}`
    )
    expect(vi.mocked(uploadRelayDirectory).mock.calls[0][2]).toContain(`orcad-${NEW_VERSION}`)
  })

  it.each([
    ['linux-arm64', 'linux-arm64-glibc'],
    ['darwin-x64', 'darwin-x64']
  ] as const)(
    'marks the %s search binary executable before completing the install',
    async (platform, target) => {
      scriptHost({ activationRecord: '', readiness: {}, log: [] })
      await deployOrcad(
        options({
          host: getRemoteHostPlatform(platform),
          target,
          census: { liveSessions: 1, startedSinceActivation: 0, daemonProtocolVersion: 3 }
        })
      )
      const chmod = mockExec.mock.calls.findIndex(([, command]) =>
        String(command).startsWith('chmod 755 ')
      )
      expect(chmod).toBeGreaterThanOrEqual(0)
      expect(mockExec.mock.calls[chmod]?.[1]).toContain(`/ripgrep/${platform}/rg'`)
      expect(mockExec.mock.calls[chmod]?.[1]).not.toContain('bun-runtime')
      expect(String(mockExec.mock.calls[chmod]?.[1]).includes('/spawn-helper')).toBe(
        platform === 'darwin-x64'
      )
      expect(ensureRemoteOrcadNodeRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ target, slotDir: `/home/u/.orca-remote/orcad-${NEW_VERSION}` })
      )
      expect(vi.mocked(uploadRelayDirectory).mock.invocationCallOrder[0]).toBeLessThan(
        mockExec.mock.invocationCallOrder[chmod]
      )
      expect(mockExec.mock.invocationCallOrder[chmod]).toBeLessThan(
        vi.mocked(finalizeInstall).mock.invocationCallOrder[0]
      )
    }
  )

  it('does not run chmod on a Windows remote', async () => {
    scriptHost({ activationRecord: '', readiness: {}, log: [] })
    await installOrcadBundle(
      {
        conn: options().conn,
        host: getRemoteHostPlatform('win32-x64'),
        localOrcadDir: '/local/out/orcad',
        target: 'win32-x64',
        nodeRuntimeArchive: async () => '/cache/node.zip'
      },
      NEW_VERSION,
      `C:/Users/u/.orca-remote/orcad-${NEW_VERSION}`
    )
    expect(uploadRelayDirectory).toHaveBeenCalledOnce()
    expect(finalizeInstall).toHaveBeenCalledOnce()
    expect(mockExec.mock.calls.some(([, command]) => String(command).startsWith('chmod '))).toBe(
      false
    )
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
    expect(uploadRelayDirectory).not.toHaveBeenCalled()
  })

  // BUG-21: a bare stale fence (a wake cut short) failed every update with "Recover it first".
  it('clears a stale fence no journal backs and goes on with the update', async () => {
    vi.mocked(isRelayInstallLockStale).mockResolvedValueOnce(true)
    let fenced = true
    mockExec.mockImplementation(async (_conn, command) => {
      const text = String(command)
      if (text.includes('echo LOCKED || echo OPEN')) {
        return fenced ? 'LOCKED\n' : 'OPEN\n'
      }
      if (text.includes('echo RELEASED')) {
        fenced = false
      }
      return text.includes('__ORCAD_RECORD_ABSENT__') ? '__ORCAD_RECORD_ABSENT__\n' : ''
    })
    await deployOrcad(options()).catch(() => undefined)
    expect(vi.mocked(acquireInstallLock).mock.calls[0]?.[3]).toMatchObject({
      allowStaleTakeover: true
    })
    expect(uploadRelayDirectory).toHaveBeenCalled()
  })

  it('leaves an upload incomplete when the remote cannot make search executable', async () => {
    mockExec.mockImplementation(async (_conn, command) => {
      if (String(command).startsWith('chmod 755 ')) {
        throw new Error('chmod failed')
      }
      return String(command).includes('__ORCAD_RECORD_ABSENT__') ? '__ORCAD_RECORD_ABSENT__\n' : ''
    })
    await expect(deployOrcad(options())).rejects.toThrow('chmod failed')
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
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

  it('allows startup time after a slow bundled preflight', async () => {
    let elapsedMs = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsedMs)
    scriptHost({
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({}) },
      readinessAtMs: 100_000,
      log: []
    })
    try {
      const result = await deployOrcad(
        options({
          readinessTimeoutMs: undefined,
          sleep: async () => {
            elapsedMs += 50_000
          }
        })
      )
      expect(result.outcome).toBe('installed-and-activated')
      expect(elapsedMs).toBe(100_000)
    } finally {
      clock.mockRestore()
    }
  })

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

  it('stops the incumbent before snapshotting, so SQLite WAL files are quiescent', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    await deployOrcad(options())
    expect(script.log.indexOf('snapshot')).toBeGreaterThan(-1)
    expect(script.log.indexOf('snapshot')).toBeLessThan(script.log.indexOf(`launch:${NEW_VERSION}`))
    expect(script.log.indexOf(`stop:${OLD_VERSION}`)).toBeLessThan(script.log.indexOf('snapshot'))
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
      code: 'orcad_update_terminals_running'
    })
    // The bytes landed; nothing was stopped, launched or snapshotted.
    expect(vi.mocked(uploadRelayDirectory)).toHaveBeenCalled()
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
    // The error carries why the candidate failed, not only where its log is.
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
    expect(result).toMatchObject({ outcome: 'installed-not-activated' })
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
      snapshotResult: 'tar: write failed'
    }
    scriptHost(script)

    await expect(deployOrcad(options())).rejects.toThrow('incumbent was stopped')
    expect(script.log).toEqual([
      'preflight',
      `stop:${OLD_VERSION}`,
      'snapshot',
      `launch:${OLD_VERSION}`
    ])
  })

  it.each(['NO_PID', 'STILL_RUNNING', 'SIGNAL_FAILED', ''])(
    'does not inspect or replace state without confirmed candidate exit: %s',
    async (candidateStopResult) => {
      const script: HostScript = {
        activationRecord: ACTIVE_OLD,
        readiness: { [NEW_VERSION]: readyLine({ selfTestOk: false }) },
        log: [],
        candidateStopResult
      }
      scriptHost(script)

      await deployOrcad(options())

      expect(script.log).toEqual([
        'preflight',
        `stop:${OLD_VERSION}`,
        'snapshot',
        `launch:${NEW_VERSION}`,
        `stop:${NEW_VERSION}`
      ])
    }
  )

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
    expect(vi.mocked(uploadRelayDirectory)).not.toHaveBeenCalled()
  })
})
