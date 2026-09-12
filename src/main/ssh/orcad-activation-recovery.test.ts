import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emptyOrcadActivationRecord,
  withActivatedVersion,
  withDeactivatedVersion,
  withDecommissioningVersion,
  withRolledBackVersion
} from './orcad-activation-record'
import {
  createOrcadActivationTransaction,
  createOrcadDecommissionTransaction,
  createOrcadRollbackTransaction,
  withOrcadActivationCandidateReady,
  withOrcadActivationSnapshot,
  withOrcadActivationTransactionPhase,
  withOrcadRollbackPhase,
  withOrcadRollbackRescue
} from './orcad-activation-transaction'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  launch: vi.fn(),
  lock: vi.fn(),
  probe: vi.fn(),
  readBuildHash: vi.fn(),
  readRecord: vi.fn(),
  readTransaction: vi.fn(),
  resolveNode: vi.fn(),
  retain: vi.fn(),
  writeRecord: vi.fn(),
  writeTransaction: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: mocks.exec }))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.readTransaction,
  writeOrcadActivationTransaction: mocks.writeTransaction
}))
vi.mock('./orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.readRecord,
  writeOrcadActivationRecord: mocks.writeRecord
}))
vi.mock('./orcad-activation-lock', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withStaleOrcadActivationRecoveryLock: mocks.lock
}))
vi.mock('./orcad-remote-build-hash', () => ({
  readRemoteOrcadBuildHash: mocks.readBuildHash
}))
vi.mock('./orcad-slot-runtime-eligibility', () => ({
  resolveOrcadSlotNodeFallback: mocks.resolveNode
}))
vi.mock('./orcad-active-readiness', () => ({
  launchOrcadSlotAndAwaitReadiness: mocks.launch,
  probeActiveOrcadReadiness: mocks.probe
}))

const { recoverInterruptedOrcadActivation } = await import('./orcad-activation-recovery')
const { RemoteInstallLockBusyError } = await import('./ssh-relay-install-lock')

const OLD_VERSION = '0.1.0+old'
const NEW_VERSION = '0.2.0+new'
const recordBefore = {
  ...emptyOrcadActivationRecord(),
  active: OLD_VERSION,
  activatedAt: new Date(1).toISOString()
}
const prepared = createOrcadActivationTransaction({
  transactionId: 'afbd47cc-13c8-4f4f-9954-8ca0dd31890b',
  candidateVersion: NEW_VERSION,
  recordBefore,
  snapshotDirName: 'pre-0.2.0+new-1000',
  now: new Date(1_000)
})
const options = {
  conn: {} as SshConnection,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/orca',
  userDataDir: '/home/orca/.orca',
  bindHost: '127.0.0.1',
  port: 6_768
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.lock.mockImplementation(async (_options, run) => run({ retain: mocks.retain }))
  mocks.readTransaction.mockResolvedValue(prepared)
  mocks.readRecord.mockResolvedValue(recordBefore)
  mocks.readBuildHash.mockResolvedValue('abc123def4567890')
  mocks.resolveNode.mockResolvedValue(undefined)
  mocks.probe.mockResolvedValue({ type: 'orca_server_ready' })
  mocks.launch.mockResolvedValue({ type: 'orca_server_ready' })
  mocks.exec.mockResolvedValue('DEAD')
  mocks.writeRecord.mockResolvedValue(undefined)
  mocks.writeTransaction.mockResolvedValue(undefined)
})

describe('interrupted orcad activation recovery', () => {
  it('stabilizes a candidate whose exact activation record committed before contact was lost', async () => {
    const snapshot = withOrcadActivationSnapshot(prepared, null, new Date(2_000))
    const recordAfter = withActivatedVersion(recordBefore, NEW_VERSION, null, new Date(3_000))
    const ready = withOrcadActivationCandidateReady(snapshot, recordAfter, new Date(3_000))
    mocks.readTransaction.mockResolvedValue(ready)
    mocks.readRecord.mockResolvedValue(recordAfter)
    mocks.exec.mockResolvedValue('LIVE')

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toEqual({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: NEW_VERSION,
      readiness: { type: 'orca_server_ready' }
    })
    expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ fullVersion: NEW_VERSION }))
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('restarts the incumbent without restoring state when candidate launch was never reached', async () => {
    const stopped = withOrcadActivationTransactionPhase(
      prepared,
      'incumbent-stopped',
      new Date(2_000)
    )
    mocks.readTransaction.mockResolvedValue(stopped)

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toEqual({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: OLD_VERSION,
      readiness: { type: 'orca_server_ready' }
    })
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ fullVersion: OLD_VERSION }))
    expect(mocks.exec).toHaveBeenCalledTimes(1)
  })

  it('stops a possible candidate, restores the snapshot, and starts the incumbent', async () => {
    const snapshotRecord = {
      dirName: prepared.snapshot.dirName,
      takenBeforeVersion: NEW_VERSION,
      readableByVersion: OLD_VERSION,
      takenAt: new Date(2_000).toISOString()
    }
    const captured = withOrcadActivationSnapshot(prepared, snapshotRecord, new Date(2_000))
    mocks.readTransaction.mockResolvedValue(captured)
    mocks.exec
      .mockResolvedValueOnce('STOPPED')
      .mockResolvedValueOnce('RESTORED')
      .mockResolvedValueOnce('DEAD')

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: OLD_VERSION
    })
    expect(String(mocks.exec.mock.calls[0]?.[1])).toContain(NEW_VERSION)
    expect(String(mocks.exec.mock.calls[1]?.[1])).toContain(snapshotRecord.dirName)
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ fullVersion: OLD_VERSION }))
  })

  it('does not overwrite state when the incumbent is already serving', async () => {
    const captured = withOrcadActivationSnapshot(prepared, null, new Date(2_000))
    mocks.readTransaction.mockResolvedValue(captured)
    mocks.exec.mockResolvedValueOnce('NO_PID').mockResolvedValueOnce('LIVE')

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'recovered',
      activeVersion: OLD_VERSION
    })
    expect(mocks.probe).toHaveBeenCalledOnce()
    expect(mocks.exec).toHaveBeenCalledTimes(3)
    expect(String(mocks.exec.mock.calls[2]?.[1])).not.toContain('orca-profile-index.json')
  })

  it('clears candidate-created state after an interrupted first activation from an empty root', async () => {
    const first = createOrcadActivationTransaction({
      transactionId: '3ba2ebd4-b294-418c-bfe2-f493f96e6445',
      candidateVersion: NEW_VERSION,
      recordBefore: emptyOrcadActivationRecord(),
      snapshotDirName: 'pre-0.2.0+new-1000',
      now: new Date(1_000)
    })
    const captured = withOrcadActivationSnapshot(first, null, new Date(2_000))
    mocks.readTransaction.mockResolvedValue(captured)
    mocks.readRecord.mockResolvedValue(emptyOrcadActivationRecord())
    mocks.exec.mockResolvedValueOnce('STOPPED').mockResolvedValueOnce('RESTORED')

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toEqual({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: null,
      readiness: null
    })
    expect(String(mocks.exec.mock.calls[1]?.[1])).toContain('orca-profile-index.json')
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('retains the fence when the activation record matches neither transaction side', async () => {
    mocks.readRecord.mockResolvedValue({ ...recordBefore, active: '0.3.0+other' })

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_activation_record_changed'
    })
    expect(mocks.retain).toHaveBeenCalledOnce()
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it('reports a fresh fence as pending instead of taking it from a live operation', async () => {
    mocks.lock.mockRejectedValue(
      new RemoteInstallLockBusyError('/home/orca/.orca-remote/.install-lock', 0)
    )

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'pending',
      code: 'orcad_recovery_transaction_still_fresh'
    })
  })

  it('retains the fence when process state cannot be proven', async () => {
    const stopped = withOrcadActivationTransactionPhase(
      prepared,
      'incumbent-stopped',
      new Date(2_000)
    )
    mocks.readTransaction.mockResolvedValue(stopped)
    mocks.exec.mockResolvedValue('UNKNOWN')

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_unverifiable'
    })
  })

  it('restores a rollback rescue and restarts the incumbent after target launch was interrupted', async () => {
    const rollbackBefore = { ...recordBefore, previous: '0.0.9+target' }
    const rollback = createOrcadRollbackTransaction({
      transactionId: '04fd3bca-3b3d-4dfa-932a-916f1ba8666c',
      incumbentVersion: OLD_VERSION,
      targetVersion: '0.0.9+target',
      recordBefore: rollbackBefore,
      recordAfter: withRolledBackVersion(rollbackBefore, new Date(2_000)),
      rescueDirName: 'rollback-rescue-0.1.0+old-1000',
      now: new Date(1_000)
    })
    const rescued = withOrcadRollbackRescue(
      withOrcadRollbackPhase(rollback, 'incumbent-stopped', new Date(2_000)),
      'captured',
      new Date(3_000)
    )
    const restored = withOrcadRollbackPhase(rescued, 'rollback-state-restored', new Date(4_000))
    mocks.readTransaction.mockResolvedValue(restored)
    mocks.readRecord.mockResolvedValue(rollbackBefore)
    mocks.exec
      .mockResolvedValueOnce('STOPPED')
      .mockResolvedValueOnce('RESTORED')
      .mockResolvedValueOnce('DEAD')

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: OLD_VERSION
    })
    expect(String(mocks.exec.mock.calls[0]?.[1])).toContain('0.0.9+target')
    expect(String(mocks.exec.mock.calls[1]?.[1])).toContain(rollback.rescue.dirName)
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ fullVersion: OLD_VERSION }))
  })

  it('stabilizes an exact committed rollback record', async () => {
    const rollbackBefore = { ...recordBefore, previous: '0.0.9+target' }
    const recordAfter = withRolledBackVersion(rollbackBefore, new Date(2_000))
    const rollback = createOrcadRollbackTransaction({
      transactionId: '04fd3bca-3b3d-4dfa-932a-916f1ba8666c',
      incumbentVersion: OLD_VERSION,
      targetVersion: '0.0.9+target',
      recordBefore: rollbackBefore,
      recordAfter,
      rescueDirName: 'rollback-rescue-0.1.0+old-1000',
      now: new Date(1_000)
    })
    mocks.readTransaction.mockResolvedValue(rollback)
    mocks.readRecord.mockResolvedValue(recordAfter)
    mocks.exec.mockResolvedValue('LIVE')

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: '0.0.9+target'
    })
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({ fullVersion: '0.0.9+target' })
    )
  })

  it('retains the fence for a third record during rollback recovery', async () => {
    const rollbackBefore = { ...recordBefore, previous: '0.0.9+target' }
    const rollback = createOrcadRollbackTransaction({
      transactionId: '04fd3bca-3b3d-4dfa-932a-916f1ba8666c',
      incumbentVersion: OLD_VERSION,
      targetVersion: '0.0.9+target',
      recordBefore: rollbackBefore,
      recordAfter: withRolledBackVersion(rollbackBefore, new Date(2_000)),
      rescueDirName: 'rollback-rescue-0.1.0+old-1000',
      now: new Date(1_000)
    })
    mocks.readTransaction.mockResolvedValue(rollback)
    mocks.readRecord.mockResolvedValue({ ...rollbackBefore, active: '0.3.0+other' })

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_rollback_record_changed'
    })
    expect(mocks.retain).toHaveBeenCalledOnce()
  })

  it('resumes a durably accepted managed stop and commits deactivation after positive exit', async () => {
    const acceptedRecord = withDecommissioningVersion(recordBefore, new Date(2_000))
    const recordAfter = withDeactivatedVersion(acceptedRecord)
    const transaction = createOrcadDecommissionTransaction({
      transactionId: '3af72817-463f-48af-89de-3e6139c24939',
      activeVersion: OLD_VERSION,
      recordBefore,
      acceptedRecord,
      recordAfter,
      now: new Date(2_000)
    })
    mocks.readTransaction.mockResolvedValue(transaction)
    mocks.readRecord.mockResolvedValue(acceptedRecord)
    mocks.exec.mockResolvedValue('STOPPED')

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toEqual({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: null,
      readiness: null
    })
    expect(mocks.writeRecord).toHaveBeenCalledWith(options, recordAfter)
    expect(mocks.writeTransaction.mock.calls.at(-1)?.[1]).toMatchObject({
      operation: 'decommission',
      phase: 'process-exited'
    })
  })

  it('stabilizes an exact decommission commit without reinterpreting contact loss', async () => {
    const acceptedRecord = withDecommissioningVersion(recordBefore, new Date(2_000))
    const recordAfter = withDeactivatedVersion(acceptedRecord)
    const transaction = createOrcadDecommissionTransaction({
      transactionId: '3af72817-463f-48af-89de-3e6139c24939',
      activeVersion: OLD_VERSION,
      recordBefore,
      acceptedRecord,
      recordAfter,
      now: new Date(2_000)
    })
    mocks.readTransaction.mockResolvedValue(transaction)
    mocks.readRecord.mockResolvedValue(recordAfter)

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: null
    })
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it('replays ambiguous decommission acceptance before stopping the runtime', async () => {
    const acceptedRecord = withDecommissioningVersion(recordBefore, new Date(2_000))
    const transaction = createOrcadDecommissionTransaction({
      transactionId: '3af72817-463f-48af-89de-3e6139c24939',
      activeVersion: OLD_VERSION,
      recordBefore,
      acceptedRecord,
      recordAfter: withDeactivatedVersion(acceptedRecord),
      now: new Date(2_000)
    })
    const requestDecommission = vi.fn().mockResolvedValue({
      outcome: 'accepted',
      transactionId: transaction.transactionId
    })
    mocks.readTransaction.mockResolvedValue(transaction)
    mocks.readRecord.mockResolvedValueOnce(recordBefore).mockResolvedValueOnce(acceptedRecord)
    mocks.exec.mockResolvedValue('ALREADY_EXITED')

    await expect(
      recoverInterruptedOrcadActivation({ ...options, requestDecommission })
    ).resolves.toMatchObject({ outcome: 'recovered', activeVersion: null })
    expect(requestDecommission).toHaveBeenCalledWith(OLD_VERSION, transaction.transactionId)
  })

  it.each(['open', 'fenced', 'unverifiable', undefined])(
    'restores a live incumbent only with confirmed open admission (%s)',
    async (terminalAdmission) => {
      const acceptedRecord = withDecommissioningVersion(recordBefore, new Date(2_000))
      const transaction = createOrcadDecommissionTransaction({
        transactionId: '3af72817-463f-48af-89de-3e6139c24939',
        activeVersion: OLD_VERSION,
        recordBefore,
        acceptedRecord,
        recordAfter: withDeactivatedVersion(acceptedRecord),
        now: new Date(2_000)
      })
      mocks.readTransaction.mockResolvedValue(transaction)
      mocks.readRecord.mockResolvedValue(recordBefore)
      mocks.exec.mockResolvedValue('LIVE')
      const requestDecommission = vi.fn().mockResolvedValue({
        outcome: 'refused',
        verdict: 'live',
        ...(terminalAdmission ? { terminalAdmission } : {}),
        code: 'orcad_decommission_live_sessions',
        reason: 'A terminal is live.'
      })

      const result = await recoverInterruptedOrcadActivation({ ...options, requestDecommission })
      if (terminalAdmission === 'open') {
        expect(result).toMatchObject({
          outcome: 'recovered',
          resolution: 'restored-incumbent',
          activeVersion: OLD_VERSION
        })
        expect(mocks.retain).not.toHaveBeenCalled()
      } else {
        expect(result).toMatchObject({ outcome: 'refused', verdict: 'live' })
        expect(mocks.retain).toHaveBeenCalledOnce()
        expect(mocks.exec).not.toHaveBeenCalled()
        expect(mocks.launch).not.toHaveBeenCalled()
        expect(mocks.writeRecord).not.toHaveBeenCalled()
      }
    }
  )

  it('keeps decommission recovery fenced when process exit is unverifiable', async () => {
    const acceptedRecord = withDecommissioningVersion(recordBefore, new Date(2_000))
    const transaction = createOrcadDecommissionTransaction({
      transactionId: '3af72817-463f-48af-89de-3e6139c24939',
      activeVersion: OLD_VERSION,
      recordBefore,
      acceptedRecord,
      recordAfter: withDeactivatedVersion(acceptedRecord),
      now: new Date(2_000)
    })
    mocks.readTransaction.mockResolvedValue(transaction)
    mocks.readRecord.mockResolvedValue(acceptedRecord)
    mocks.exec.mockResolvedValue('NO_PID')

    await expect(recoverInterruptedOrcadActivation(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_stop_unverifiable'
    })
    expect(mocks.retain).toHaveBeenCalledOnce()
  })
})
