import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    'sshChannelCloseConfirmed' in error &&
    error.sshChannelCloseConfirmed === false
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-install-transfers', () => ({
  writeRelayFile: vi.fn().mockResolvedValue(undefined),
  uploadRelayDirectory: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./orcad-activation-record-store', () => ({
  readOrcadActivationRecord: vi.fn(),
  writeOrcadActivationRecord: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./orcad-activation-transaction-store', () => ({
  writeOrcadActivationTransaction: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./orcad-remote-build-hash', () => ({
  readRemoteOrcadBuildHash: vi.fn().mockResolvedValue('abc123def4567890')
}))
vi.mock('./orcad-slot-runtime-eligibility', () => ({
  resolveOrcadSlotNodeFallback: vi.fn().mockResolvedValue('/usr/bin/node')
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { rollbackOrcad, type OrcadRollbackOptions } from './orcad-remote-rollback'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { emptyOrcadActivationRecord, type OrcadActivationRecord } from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

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
  const endpoint = 'ws://127.0.0.1:7777'
  return JSON.stringify({
    type: 'orca_server_ready',
    schemaVersion: 1,
    runtimeId: 'r1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: 'public-key',
        pairedDeviceId: 'device-1',
        scope: 'runtime'
      }),
      endpoint,
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    },
    health: {
      buildHash: BUILD_HASH,
      buildVersion: version,
      nodeVersion: '20.11.0',
      nodeAbi: '115',
      runtimeKind: 'node',
      ptyBackend: 'node-pty',
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

function scriptHost(
  log: string[],
  overrides: { restore?: string; rescueCapture?: string; rescueRestore?: string } = {}
): void {
  mockExec.mockImplementation(async (_conn, command: string) => {
    const text = String(command)
    if (text.includes('state.tar') && text.includes('test -f') && !text.includes('tar -C')) {
      return 'PRESENT'
    }
    if (text.includes('find ') && text.includes('stat')) {
      return 'UNKNOWN'
    }
    if (text.includes('.orcad-stop-request') && text.includes('STILL_RUNNING')) {
      log.push(`stop:${text.includes(ACTIVE) ? ACTIVE : TARGET}`)
      return 'STOPPED'
    }
    if (text.includes('rollback-rescue') && text.includes('-cf')) {
      log.push('rescue')
      return overrides.rescueCapture ?? 'CAPTURED'
    }
    if (text.includes('tar -C') && text.includes('-xf')) {
      const rescue = text.includes('rollback-rescue')
      log.push(rescue ? 'restore-rescue' : 'restore')
      return rescue ? (overrides.rescueRestore ?? 'RESTORED') : (overrides.restore ?? 'RESTORED')
    }
    if (text.includes('nohup')) {
      log.push(`launch:${text.includes(ACTIVE) ? ACTIVE : TARGET}`)
      return '9999'
    }
    if (text.startsWith('head -c ') && text.includes('.orcad-readiness')) {
      return readyLine(text.includes(ACTIVE) ? ACTIVE : TARGET)
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
    vi.mocked(readOrcadActivationRecord).mockResolvedValue(record())
  })

  it('stops, restores state, then starts the target — in that order', async () => {
    const log: string[] = []
    scriptHost(log)
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'rolled-back', target: TARGET })
    // Restoring under a running orcad would replace the store beneath a process holding it;
    // starting first would let the older build migrate the newer build's state.
    expect(log).toEqual([`stop:${ACTIVE}`, 'rescue', 'restore', `launch:${TARGET}`])
    expect(vi.mocked(writeOrcadActivationTransaction).mock.calls.map(([, tx]) => tx.phase)).toEqual(
      [
        'prepared',
        'incumbent-stopped',
        'rescue-captured',
        'rollback-state-restored',
        'target-ready'
      ]
    )
  })

  it('polls pending readiness and stops sleeping once the target answers', async () => {
    scriptHost([])
    const baseImplementation = mockExec.getMockImplementation()
    let pending = true
    const sleep = vi.fn(async () => {
      pending = false
    })
    mockExec.mockImplementation(async (conn, command, execOptions) => {
      if (pending && command.startsWith('head -c ') && command.includes('.orcad-readiness')) {
        return ''
      }
      return baseImplementation?.(conn, command, execOptions) ?? ''
    })

    await expect(rollbackOrcad(options({ sleep }))).resolves.toMatchObject({
      outcome: 'rolled-back'
    })

    expect(sleep).toHaveBeenCalledExactlyOnceWith(500)
  })

  it.each(['STILL_RUNNING', 'NO_PID', 'UNKNOWN'])(
    'does not restore or launch when the active stop answers %s',
    async (stopOutput) => {
      const log: string[] = []
      scriptHost(log)
      const baseImplementation = mockExec.getMockImplementation()
      mockExec.mockImplementation(async (conn, command, execOptions) => {
        const output = await baseImplementation?.(conn, command, execOptions)
        return output === 'STOPPED' ? stopOutput : (output ?? '')
      })

      await expect(rollbackOrcad(options())).resolves.toMatchObject({
        outcome: 'failed',
        code: 'orcad_rollback_stop_incomplete'
      })

      expect(log).toEqual([`stop:${ACTIVE}`])
      expect(writeOrcadActivationRecord).not.toHaveBeenCalled()
    }
  )

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
    expect(writeOrcadActivationRecord).not.toHaveBeenCalled()
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

  it('reports a failed snapshot probe as unverifiable instead of absent', async () => {
    mockExec.mockRejectedValueOnce(new Error('snapshot probe failed'))

    const result = await rollbackOrcad(options())

    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'orcad_rollback_snapshot_unverifiable'
    })
  })

  it('propagates unconfirmed snapshot-probe teardown so the fence stays held', async () => {
    const error = Object.assign(new Error('transport lost during snapshot probe'), {
      sshChannelCloseConfirmed: false
    })
    mockExec.mockRejectedValueOnce(error)

    await expect(rollbackOrcad(options())).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledOnce()
  })

  it('restores the rescue state and restarts the active build when restore fails', async () => {
    const log: string[] = []
    scriptHost(log, { restore: 'FAILED' })
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'failed', code: 'orcad_rollback_restore_failed' })
    expect(log).toEqual([
      `stop:${ACTIVE}`,
      'rescue',
      'restore',
      'restore-rescue',
      `launch:${ACTIVE}`
    ])
    expect(result.outcome === 'failed' && result.reason).toContain(
      'was restored and is serving again'
    )
  })

  it('cancels before restore and restarts the active build when rescue capture fails', async () => {
    const log: string[] = []
    scriptHost(log, { rescueCapture: 'FAILED' })

    await expect(rollbackOrcad(options())).resolves.toMatchObject({
      outcome: 'failed',
      code: 'orcad_rollback_rescue_snapshot_failed'
    })

    expect(log).toEqual([`stop:${ACTIVE}`, 'rescue', `launch:${ACTIVE}`])
  })

  it('retains the host fence when neither rollback state nor rescue state can be restored', async () => {
    const log: string[] = []
    scriptHost(log, { restore: 'FAILED', rescueRestore: 'FAILED' })

    await expect(rollbackOrcad(options())).resolves.toMatchObject({
      outcome: 'failed',
      code: 'orcad_rollback_restore_failed'
    })

    expect(log).toEqual([`stop:${ACTIVE}`, 'rescue', 'restore', 'restore-rescue'])
    expect(
      mockExec.mock.calls.some(([, command]) =>
        String(command).includes('.orcad-activation-transaction')
      )
    ).toBe(false)
  })

  it('leaves the record naming the newer version when the target fails to come up', async () => {
    const log: string[] = []
    scriptHost(log)
    const baseImplementation = mockExec.getMockImplementation()
    mockExec.mockImplementation(async (conn, command: string, execOptions) => {
      const text = String(command)
      if (
        text.startsWith('head -c ') &&
        text.includes('.orcad-readiness') &&
        text.includes(TARGET)
      ) {
        return ''
      }
      return baseImplementation?.(conn, command, execOptions) ?? ''
    })
    const result = await rollbackOrcad(options())
    expect(result).toMatchObject({ outcome: 'failed', code: 'orcad_activation_no_readiness' })
    // Until the target is proven serving, `active` must still name the version an operator
    // would have to bring back.
    expect(writeOrcadActivationRecord).not.toHaveBeenCalled()
    expect(log).toEqual([
      `stop:${ACTIVE}`,
      'rescue',
      'restore',
      `launch:${TARGET}`,
      `stop:${TARGET}`,
      'restore-rescue',
      `launch:${ACTIVE}`
    ])
  })

  it.each(['probe failure', 'cancellation'])(
    'restores the rescue state after target readiness %s',
    async (failure) => {
      const log: string[] = []
      scriptHost(log)
      const controller = new AbortController()
      const baseImplementation = mockExec.getMockImplementation()
      mockExec.mockImplementation(async (conn, command: string, execOptions) => {
        const text = String(command)
        if (
          text.startsWith('head -c ') &&
          text.includes('.orcad-readiness') &&
          text.includes(TARGET)
        ) {
          if (failure === 'cancellation') {
            return ''
          }
          throw new Error('confirmed readiness read failed')
        }
        if (controller.signal.aborted) {
          expect(execOptions?.signal).toBeUndefined()
        }
        return baseImplementation?.(conn, command, execOptions) ?? ''
      })

      const result = await rollbackOrcad(
        options({
          signal: controller.signal,
          readinessTimeoutMs: 5_000,
          sleep: async () => controller.abort(new Error('cancelled during readiness'))
        })
      )

      expect(result).toMatchObject({
        outcome: 'failed',
        code: 'orcad_rollback_target_launch_failed'
      })
      expect(writeOrcadActivationRecord).not.toHaveBeenCalled()
      expect(log).toEqual([
        `stop:${ACTIVE}`,
        'rescue',
        'restore',
        `launch:${TARGET}`,
        `stop:${TARGET}`,
        'restore-rescue',
        `launch:${ACTIVE}`
      ])
      expect(result.outcome === 'failed' && result.reason).toContain(
        `orcad ${ACTIVE} was restored and is serving again`
      )
    }
  )

  it('records the rollback only after the target answers healthy', async () => {
    const log: string[] = []
    scriptHost(log)
    await rollbackOrcad(options())
    const written = vi.mocked(writeOrcadActivationRecord).mock.calls[0]?.[1]
    expect(written).toMatchObject({
      active: TARGET,
      previous: null,
      snapshot: null
    })
  })

  it('refuses when the activation record changed while the rollback waited for its lock', async () => {
    vi.mocked(readOrcadActivationRecord).mockResolvedValue(record({ active: '0.3.0+cc01' }))
    const log: string[] = []
    scriptHost(log)

    await expect(rollbackOrcad(options())).resolves.toMatchObject({
      outcome: 'refused',
      code: 'orcad_rollback_record_changed'
    })
    expect(log).toEqual([])
  })
})
