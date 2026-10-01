import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RecordFile from './orcad-remote-record-file'
import type * as InstallLock from './ssh-relay-install-lock'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: () => false
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-install-transfers', () => ({
  writeRelayFile: vi.fn().mockResolvedValue(undefined),
  uploadRelayDirectory: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./ssh-relay-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./orcad-remote-record-file', async (importOriginal) => ({
  ...(await importOriginal<typeof RecordFile>()),
  writeAtomicOrcadRemoteRecord: vi.fn().mockResolvedValue(undefined)
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { writeAtomicOrcadRemoteRecord } from './orcad-remote-record-file'
import { rollbackOrcad, type OrcadRollbackOptions } from './orcad-remote-rollback'
import { emptyOrcadActivationRecord, type OrcadActivationRecord } from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'

const mockExec = vi.mocked(execCommand)
const ACTIVE = '0.2.0+bb01'
const TARGET = '0.1.0+aa01'
const BUILD_HASH = 'abc123def4567890'

function record(overrides: Partial<OrcadActivationRecord> = {}): OrcadActivationRecord {
  return {
    ...emptyOrcadActivationRecord(),
    active: ACTIVE,
    previous: TARGET,
    activatedAt: '2026-01-01T00:00:00.000Z',
    snapshot: {
      dirName: 'pre-0.2.0+bb01-1000',
      takenBeforeVersion: ACTIVE,
      readableByVersion: TARGET,
      takenAt: '2026-01-01T00:00:00.000Z'
    },
    ...overrides
  }
}

function readyLine(version: string): string {
  return JSON.stringify({
    type: 'orca_server_ready',
    schemaVersion: 1,
    runtimeId: 'r1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
    health: {
      buildHash: BUILD_HASH,
      buildVersion: version,
      nodeVersion: '20.11.0',
      nodeAbi: '115',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      terminalDaemon: {
        state: 'live',
        ownsFreshSessions: true,
        pid: 2,
        buildVersion: version,
        entryPath: '/x/daemon-entry.js',
        protocolVersion: 3,
        selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 5 }
      }
    }
  })
}

type HostOverrides = {
  restores?: string[]
  readinessAtMs?: number
  targetReady?: boolean
  snapshot?: string
  comparison?: string
}

function scriptHost(log: string[], overrides: HostOverrides = {}): void {
  const restores = [...(overrides.restores ?? [])]
  mockExec.mockImplementation(async (_conn, command: string) => {
    const text = String(command)
    if (text.includes('__ORCAD_RECORD_PRESENT__')) {
      return text.includes('transaction.json')
        ? '__ORCAD_RECORD_ABSENT__\n'
        : `__ORCAD_RECORD_PRESENT__\n${JSON.stringify(record())}`
    }
    if (text.includes('__ORCAD_BUILD_HASH__')) {
      return `__ORCAD_BUILD_HASH__ ${BUILD_HASH}\n`
    }
    if (text.includes('echo PRESENT')) {
      return overrides.snapshot ?? 'PRESENT'
    }
    if (text.includes('stat -c %Y')) {
      return 'UNKNOWN'
    }
    if (text.includes('kill -TERM')) {
      log.push(`stop:${text.includes(ACTIVE) ? ACTIVE : TARGET}`)
      return 'STOPPED'
    }
    if (text.includes('verdict=UNCHANGED')) {
      log.push('compare')
      return overrides.comparison ?? 'CHANGED'
    }
    if (text.includes('tar -C') && text.includes('-cf')) {
      log.push('rescue')
      return 'CAPTURED'
    }
    if (text.includes('tar -C') && text.includes('-xf')) {
      log.push(text.includes('rollback-rescue-') ? 'restore-rescue' : 'restore')
      return restores.shift() ?? 'RESTORED'
    }
    if (text.includes('nohup')) {
      log.push(`launch:${text.includes(ACTIVE) ? ACTIVE : TARGET}`)
      return '9999'
    }
    if (text.startsWith('head -c ') && text.includes('.orcad-readiness')) {
      if (overrides.readinessAtMs !== undefined && Date.now() < overrides.readinessAtMs) {
        return ''
      }
      if (text.includes(ACTIVE)) {
        return readyLine(ACTIVE)
      }
      return overrides.targetReady === false ? '' : readyLine(TARGET)
    }
    return ''
  })
}

function options(overrides: Partial<OrcadRollbackOptions> = {}): OrcadRollbackOptions {
  return {
    conn: {} as SshConnection,
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/u',
    record: record(),
    nodePath: '/usr/bin/node',
    userDataDir: '/home/u/.orca',
    bindHost: '127.0.0.1',
    port: 7777,
    census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 },
    targetBuildHash: BUILD_HASH,
    targetDaemonProtocol: { protocolVersion: 3, previousProtocolVersions: [1, 2] },
    readinessTimeoutMs: 50,
    sleep: async () => {},
    now: () => new Date('2026-02-02T00:00:00.000Z'),
    ...overrides
  }
}

describe('rollbackOrcad', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stops, restores state, then starts the target — in that order', async () => {
    const log: string[] = []
    scriptHost(log)
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'rolled-back', target: TARGET })
    // Restoring under a running orcad would replace the store beneath a process holding it;
    // starting first would let the older build migrate the newer build's state.
    expect(log).toEqual([`stop:${ACTIVE}`, 'rescue', 'restore', `launch:${TARGET}`])
  })

  it('allows rollback startup time after a slow bundled preflight', async () => {
    let elapsedMs = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsedMs)
    const log: string[] = []
    scriptHost(log, { readinessAtMs: 100_000 })
    try {
      const result = await rollbackOrcad(
        options({
          readinessTimeoutMs: undefined,
          sleep: async () => {
            elapsedMs += 50_000
          }
        })
      )
      expect(result.outcome).toBe('rolled-back')
      expect(elapsedMs).toBe(100_000)
      expect(log).toEqual([`stop:${ACTIVE}`, 'rescue', 'restore', `launch:${TARGET}`])
    } finally {
      clock.mockRestore()
    }
  })

  it('refuses before touching anything when terminals started after activation', async () => {
    const log: string[] = []
    scriptHost(log)
    const result = await rollbackOrcad(
      options({ census: { liveSessions: 3, startedSinceActivation: 2, daemonProtocolVersion: 3 } })
    )
    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'orcad_rollback_orphans_live_terminals'
    })
    expect(log).toEqual([])
    expect(vi.mocked(writeAtomicOrcadRemoteRecord)).not.toHaveBeenCalled()
  })

  it('refuses when the snapshot is gone from the host', async () => {
    const log: string[] = []
    scriptHost(log, { snapshot: 'ABSENT' })
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'refused', code: 'orcad_rollback_snapshot_missing' })
    expect(log).toEqual([])
  })

  it('does not read a lost snapshot probe as a missing snapshot', async () => {
    const log: string[] = []
    scriptHost(log, { snapshot: '' })
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'orcad_rollback_snapshot_unverifiable'
    })
    expect(log).toEqual([])
  })

  it('puts the rescued state and the newer build back when the restore failed', async () => {
    const log: string[] = []
    scriptHost(log, { restores: ['FAILED'] })
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'failed', code: 'orcad_rollback_restore_failed' })
    expect(log).toEqual([
      `stop:${ACTIVE}`,
      'rescue',
      'restore',
      'restore-rescue',
      `launch:${ACTIVE}`
    ])
    expect(result.outcome === 'failed' && result.reason).toContain('is serving again')
  })

  it('keeps the newer state when a failed target may have changed it and no census is fresh', async () => {
    const log: string[] = []
    scriptHost(log, { targetReady: false })
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'failed', code: 'orcad_activation_no_readiness' })
    expect(result.outcome === 'failed' && result.reason).toContain('fresh host terminal census')
    expect(log).toEqual([
      `stop:${ACTIVE}`,
      'rescue',
      'restore',
      `launch:${TARGET}`,
      `stop:${TARGET}`,
      'compare'
    ])
    // Until the target is proven serving, `active` must still name the version an operator
    // would have to bring back.
    expect(
      vi
        .mocked(writeAtomicOrcadRemoteRecord)
        .mock.calls.some((call) => String(call[1]).endsWith('orcad-active.json'))
    ).toBe(false)
  })

  it('restores the rescue and the newer build after a failed target when no terminal started', async () => {
    const log: string[] = []
    scriptHost(log, { targetReady: false })
    const result = await rollbackOrcad(options({ terminalsStartedSince: async () => 0 }))
    expect(result.outcome === 'failed' && result.reason).toContain('is serving again')
    expect(log.slice(-3)).toEqual(['compare', 'restore-rescue', `launch:${ACTIVE}`])
  })

  it('records the rollback only after the target answers healthy', async () => {
    const log: string[] = []
    scriptHost(log)
    await rollbackOrcad(options())
    const written = vi
      .mocked(writeAtomicOrcadRemoteRecord)
      .mock.calls.find((call) => String(call[1]).endsWith('orcad-active.json'))
    expect(JSON.parse(String(written?.[2]))).toMatchObject({
      active: TARGET,
      previous: null,
      snapshot: null
    })
  })
})
