import { describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'
import type * as InstallLock from './ssh-relay-install-lock'

vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployHelpers>()),
  execCommand: vi.fn().mockResolvedValue('')
}))
vi.mock('./ssh-relay-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn().mockResolvedValue(undefined)
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { acquireInstallLock } from './ssh-relay-install-lock'
import {
  parseOrcadActivationTransaction,
  planOrcadTransactionRecovery,
  serializeOrcadActivationTransaction,
  type OrcadActivationTransaction
} from './orcad-activation-transaction'
import {
  createOrcadActivationTransaction,
  createOrcadRollbackTransaction,
  withOrcadActivationCandidateReady,
  withOrcadActivationIncumbentStopped,
  withOrcadActivationSnapshot,
  withOrcadRollbackPhase,
  withOrcadRollbackRescue
} from './orcad-activation-transaction-transitions'
import {
  resolveOrcadActivationReadinessTimeout,
  withOrcadActivationLock,
  withStaleOrcadActivationRecoveryLock
} from './orcad-activation-lock'
import { FakeOrcadHost, NEW, OLD } from './orcad-activation-host-test-harness'
import { withRolledBackVersion } from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'

const T = new Date('2026-02-02T00:00:00.000Z')
const ID = '7f1c2a7e-6c1b-4a8e-9f0e-0a1b2c3d4e5f'
const before = FakeOrcadHost.newRecord()

function activation(): ReturnType<typeof createOrcadActivationTransaction> {
  return createOrcadActivationTransaction({
    transactionId: ID,
    candidateVersion: '0.3.0+cc01',
    recordBefore: before,
    snapshotDirName: 'pre-0.3.0+cc01-1',
    now: T
  })
}

function rollback(): ReturnType<typeof createOrcadRollbackTransaction> {
  return createOrcadRollbackTransaction({
    transactionId: ID,
    incumbentVersion: NEW,
    targetVersion: OLD,
    recordBefore: before,
    recordAfter: withRolledBackVersion(before, T),
    rescueDirName: 'rollback-rescue-0.2.0+bb01-1',
    now: T
  })
}

const roundTrip = (transaction: OrcadActivationTransaction): unknown =>
  parseOrcadActivationTransaction(serializeOrcadActivationTransaction(transaction))

describe('parseOrcadActivationTransaction', () => {
  it('round-trips every phase of both operations', () => {
    const stopped = withOrcadActivationIncumbentStopped(activation(), T)
    const captured = withOrcadActivationSnapshot(stopped, 'captured', T)
    const ready = withOrcadActivationCandidateReady(
      captured,
      { ...before, active: '0.3.0+cc01' },
      T
    )
    const rescued = withOrcadRollbackRescue(
      withOrcadRollbackPhase(rollback(), 'incumbent-stopped', T),
      'empty',
      T
    )
    for (const transaction of [activation(), stopped, captured, ready, rollback(), rescued]) {
      expect(roundTrip(transaction)).toEqual({ state: 'ok', transaction })
    }
  })

  it.each([
    ['an unknown operation, so an older client keeps a newer fence', { operation: 'decommission' }],
    ['a snapshot verdict before its phase', { snapshot: { dirName: 'pre-x', state: 'captured' } }],
    ['a committed record before candidate-ready', { recordAfter: before }],
    ['an unsafe version', { candidateVersion: '../../etc' }],
    ['an unsafe snapshot name', { snapshot: { dirName: '../x', state: 'pending' } }]
  ])('reads %s as unreadable', (_name, patch) => {
    const raw = JSON.stringify({ ...activation(), ...patch })
    expect(parseOrcadActivationTransaction(raw)).toMatchObject({ state: 'unreadable' })
  })

  it('rejects a rollback whose versions disagree with its records', () => {
    const raw = JSON.stringify({ ...rollback(), targetVersion: '0.0.9+dd01' })
    expect(parseOrcadActivationTransaction(raw)).toMatchObject({ state: 'unreadable' })
  })
})

describe('planOrcadTransactionRecovery', () => {
  const after = { ...before, active: '0.3.0+cc01' }
  const captured = withOrcadActivationSnapshot(
    withOrcadActivationIncumbentStopped(activation(), T),
    'captured',
    T
  )

  it.each([
    ['prepared', activation(), null, null],
    ['incumbent-stopped', withOrcadActivationIncumbentStopped(activation(), T), null, null],
    ['snapshot-captured', captured, '0.3.0+cc01', 'captured']
  ] as const)('undoes an activation interrupted at %s', (_phase, transaction, launched, state) => {
    expect(planOrcadTransactionRecovery(transaction, before)).toMatchObject({
      action: 'undo',
      launchedVersion: launched,
      activeVersion: NEW,
      restoreState: state === null ? null : { state }
    })
  })

  it('finishes a commit whose record write was lost, and stabilizes one that landed', () => {
    const ready = withOrcadActivationCandidateReady(captured, after, T)
    expect(planOrcadTransactionRecovery(ready, before)).toEqual({
      action: 'finish-commit',
      record: after
    })
    expect(planOrcadTransactionRecovery(ready, after)).toEqual({
      action: 'stabilize-committed',
      activeVersion: '0.3.0+cc01'
    })
  })

  it('restores the rescue once a rollback may have replaced the state', () => {
    const rescued = withOrcadRollbackRescue(rollback(), 'captured', T)
    expect(planOrcadTransactionRecovery(rescued, before)).toMatchObject({
      action: 'undo',
      launchedVersion: null,
      activeVersion: NEW,
      restoreState: { state: 'captured' }
    })
    expect(
      planOrcadTransactionRecovery(
        withOrcadRollbackPhase(rescued, 'rollback-state-restored', T),
        before
      )
    ).toMatchObject({ launchedVersion: OLD })
  })

  it('refuses when the record matches neither side', () => {
    expect(planOrcadTransactionRecovery(activation(), { ...before, previous: null })).toMatchObject(
      {
        action: 'refuse',
        code: 'orcad_recovery_activation_record_changed'
      }
    )
  })
})

describe('activation fence', () => {
  const target = {
    conn: {} as SshConnection,
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/u'
  }
  const removals = (): string[] =>
    vi
      .mocked(execCommand)
      .mock.calls.map(([, command]) => command)
      .filter((command) => command.includes('rm -'))

  it('never takes over a held fence by age, and removes the journal before the lock', async () => {
    vi.clearAllMocks()
    await withOrcadActivationLock(target, async () => undefined)
    expect(vi.mocked(acquireInstallLock).mock.calls[0]?.[3]).toMatchObject({
      allowStaleTakeover: false,
      relayGcClaim: false
    })
    const [release] = removals()
    expect(release?.indexOf('transaction.json')).toBeLessThan(
      release?.indexOf("rm -rf '/home/u/.orca-remote/.orcad-activation-transaction'") ?? -1
    )
  })

  it('keeps the fence after an unconfirmed termination, a retained error, or retain()', async () => {
    vi.clearAllMocks()
    const lost = Object.assign(new Error('lost'), { sshChannelCloseConfirmed: false })
    await expect(withOrcadActivationLock(target, () => Promise.reject(lost))).rejects.toBe(lost)
    await expect(
      withOrcadActivationLock(target, async (lock) => {
        lock.retainOnError()
        throw new Error('mid-transaction')
      })
    ).rejects.toThrow('mid-transaction')
    await withOrcadActivationLock(target, async (lock) => lock.retain())
    expect(removals()).toEqual([])
  })

  it('releases after a recovered failure even though the run throws', async () => {
    vi.clearAllMocks()
    await expect(
      withOrcadActivationLock(target, async (lock) => {
        lock.retainOnError()
        lock.recovered()
        throw new Error('snapshot failed; incumbent restarted')
      })
    ).rejects.toThrow('incumbent restarted')
    expect(removals()).toHaveLength(1)
  })

  it('lets recovery take over only stale fences, without waiting', async () => {
    vi.clearAllMocks()
    await withStaleOrcadActivationRecoveryLock(target, async () => undefined)
    expect(vi.mocked(acquireInstallLock).mock.calls[0]?.[3]).toMatchObject({
      allowStaleTakeover: true,
      waitTimeoutMs: 0
    })
  })

  it.each([0, -1, 5 * 60_000 + 1, 1.5])('rejects readiness timeout %s', (timeout) => {
    expect(() => resolveOrcadActivationReadinessTimeout(timeout, 1)).toThrow()
  })
})
