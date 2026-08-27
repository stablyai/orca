import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: () => false
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-install-transfers', () => ({
  writeRelayFile: vi.fn().mockResolvedValue(undefined),
  uploadRelayDirectory: vi.fn().mockResolvedValue(undefined)
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { writeRelayFile } from './ssh-relay-install-transfers'
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

function scriptHost(log: string[], overrides: { restore?: string } = {}): void {
  mockExec.mockImplementation(async (_conn, command: string) => {
    const text = String(command)
    if (text.includes('state.tar') && text.includes('test -f') && !text.includes('tar -C')) {
      return 'PRESENT'
    }
    if (text.includes('find ') && text.includes('stat')) {
      return 'UNKNOWN'
    }
    if (text.includes('kill -TERM')) {
      log.push(`stop:${text.includes(ACTIVE) ? ACTIVE : TARGET}`)
      return 'STOPPED'
    }
    if (text.includes('tar -C') && text.includes('-xf')) {
      log.push('restore')
      return overrides.restore ?? 'RESTORED'
    }
    if (text.includes('nohup')) {
      log.push(`launch:${text.includes(ACTIVE) ? ACTIVE : TARGET}`)
      return '9999'
    }
    if (text.startsWith('cat ') && text.includes('.orcad-readiness')) {
      return readyLine(TARGET)
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
    census: { liveSessions: 0, startedSinceActivation: 0 },
    targetBuildHash: BUILD_HASH,
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
    expect(log).toEqual([`stop:${ACTIVE}`, 'restore', `launch:${TARGET}`])
  })

  it('refuses before touching anything when terminals started after activation', async () => {
    const log: string[] = []
    scriptHost(log)
    const result = await rollbackOrcad(
      options({ census: { liveSessions: 3, startedSinceActivation: 2 } })
    )
    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'orcad_rollback_orphans_live_terminals'
    })
    expect(log).toEqual([])
    expect(vi.mocked(writeRelayFile)).not.toHaveBeenCalled()
  })

  it('refuses when the snapshot is gone from the host', async () => {
    const log: string[] = []
    mockExec.mockImplementation(async (_conn, command: string) =>
      String(command).includes('state.tar') ? 'ABSENT' : ''
    )
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'refused', code: 'orcad_rollback_snapshot_missing' })
    expect(log).toEqual([])
  })

  it('does not start the old build when the restore failed', async () => {
    const log: string[] = []
    scriptHost(log, { restore: 'FAILED' })
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'failed', code: 'orcad_rollback_restore_failed' })
    expect(log).toEqual([`stop:${ACTIVE}`, 'restore'])
    expect(result.outcome === 'failed' && result.reason).toContain('Do NOT start the older build')
  })

  it('leaves the record naming the newer version when the target fails to come up', async () => {
    const log: string[] = []
    scriptHost(log)
    mockExec.mockImplementation(async (_conn, command: string) => {
      const text = String(command)
      if (text.includes('state.tar') && text.includes('test -f') && !text.includes('tar -C')) {
        return 'PRESENT'
      }
      if (text.includes('kill -TERM')) {
        return 'STOPPED'
      }
      if (text.includes('tar -C') && text.includes('-xf')) {
        return 'RESTORED'
      }
      // The target never publishes readiness.
      return ''
    })
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'failed', code: 'orcad_activation_no_readiness' })
    // Until the target is proven serving, `active` must still name the version an operator
    // would have to bring back.
    expect(vi.mocked(writeRelayFile)).not.toHaveBeenCalled()
  })

  it('records the rollback only after the target answers healthy', async () => {
    const log: string[] = []
    scriptHost(log)
    await rollbackOrcad(options())
    const written = vi
      .mocked(writeRelayFile)
      .mock.calls.find((call) => String(call[2]).endsWith('orcad-active.json'))
    expect(JSON.parse(String(written?.[3]))).toMatchObject({
      active: TARGET,
      previous: null,
      snapshot: null
    })
  })
})
