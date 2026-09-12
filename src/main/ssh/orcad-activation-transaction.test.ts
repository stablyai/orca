import { describe, expect, it } from 'vitest'
import {
  createOrcadActivationTransaction,
  createOrcadRollbackTransaction,
  parseOrcadActivationTransaction,
  planOrcadActivationRecovery,
  serializeOrcadActivationTransaction,
  withOrcadActivationCandidateReady,
  withOrcadActivationSnapshot,
  withOrcadActivationTransactionPhase,
  withOrcadRollbackPhase,
  withOrcadRollbackRescue
} from './orcad-activation-transaction'
import {
  emptyOrcadActivationRecord,
  withActivatedVersion,
  withRolledBackVersion
} from './orcad-activation-record'

const transactionId = 'afbd47cc-13c8-4f4f-9954-8ca0dd31890b'
const before = {
  ...emptyOrcadActivationRecord(),
  active: '0.1.0+old',
  activatedAt: new Date(1).toISOString()
}

function prepared() {
  return createOrcadActivationTransaction({
    transactionId,
    candidateVersion: '0.2.0+new',
    recordBefore: before,
    snapshotDirName: 'pre-0.2.0+new-1000',
    now: new Date(1_000)
  })
}

describe('orcad activation transaction', () => {
  it('round-trips every durable activation checkpoint', () => {
    const stopped = withOrcadActivationTransactionPhase(
      prepared(),
      'incumbent-stopped',
      new Date(2_000)
    )
    const snapshot = {
      dirName: stopped.snapshot.dirName,
      takenBeforeVersion: stopped.candidateVersion,
      readableByVersion: stopped.recordBefore.active,
      takenAt: new Date(3_000).toISOString()
    }
    const captured = withOrcadActivationSnapshot(stopped, snapshot, new Date(3_000))
    const recordAfter = withActivatedVersion(
      captured.recordBefore,
      captured.candidateVersion,
      snapshot,
      new Date(4_000)
    )
    const ready = withOrcadActivationCandidateReady(captured, recordAfter, new Date(4_000))

    expect(parseOrcadActivationTransaction(serializeOrcadActivationTransaction(ready))).toEqual({
      state: 'ok',
      transaction: ready
    })
  })

  it('records an originally empty snapshot without fabricating an archive', () => {
    const stopped = withOrcadActivationTransactionPhase(
      prepared(),
      'incumbent-stopped',
      new Date(2_000)
    )
    const captured = withOrcadActivationSnapshot(stopped, null, new Date(3_000))

    expect(captured).toMatchObject({
      phase: 'snapshot-captured',
      snapshot: { dirName: 'pre-0.2.0+new-1000', state: 'empty' },
      recordAfter: null
    })
  })

  it('rejects a phase that could launch a candidate without a snapshot verdict', () => {
    const invalid = { ...prepared(), phase: 'snapshot-captured' }

    expect(parseOrcadActivationTransaction(JSON.stringify(invalid))).toMatchObject({
      state: 'unreadable',
      reason: expect.stringContaining('Snapshot phase has no durable verdict')
    })
  })

  it('rejects a candidate-ready phase without the exact committed record', () => {
    const invalid = {
      ...prepared(),
      phase: 'candidate-ready',
      snapshot: { dirName: 'pre-0.2.0+new-1000', state: 'empty' }
    }

    expect(parseOrcadActivationTransaction(JSON.stringify(invalid))).toMatchObject({
      state: 'unreadable',
      reason: expect.stringContaining('Committed record is inconsistent with phase')
    })
  })

  it('rejects a malformed nested activation record', () => {
    const invalid = { ...prepared(), recordBefore: { schemaVersion: 99 } }

    expect(parseOrcadActivationTransaction(JSON.stringify(invalid))).toMatchObject({
      state: 'unreadable',
      reason: expect.stringContaining('recordBefore is invalid')
    })
  })

  it('stabilizes the exact committed side after a lost record-write response', () => {
    const captured = withOrcadActivationSnapshot(prepared(), null, new Date(3_000))
    const recordAfter = withActivatedVersion(
      captured.recordBefore,
      captured.candidateVersion,
      null,
      new Date(4_000)
    )
    const ready = withOrcadActivationCandidateReady(captured, recordAfter, new Date(4_000))

    expect(planOrcadActivationRecovery(ready, recordAfter)).toEqual({
      action: 'stabilize-committed',
      record: recordAfter
    })
  })

  it('restarts the incumbent without restoring state before candidate launch', () => {
    const stopped = withOrcadActivationTransactionPhase(
      prepared(),
      'incumbent-stopped',
      new Date(2_000)
    )

    expect(planOrcadActivationRecovery(stopped, before)).toMatchObject({
      action: 'restore-record-before',
      restoreSnapshot: false,
      record: before
    })
  })

  it('restores captured state when a candidate may have owned the data root', () => {
    const snapshot = {
      dirName: prepared().snapshot.dirName,
      takenBeforeVersion: '0.2.0+new',
      readableByVersion: '0.1.0+old',
      takenAt: new Date(3_000).toISOString()
    }
    const captured = withOrcadActivationSnapshot(prepared(), snapshot, new Date(3_000))

    expect(planOrcadActivationRecovery(captured, before)).toMatchObject({
      action: 'restore-record-before',
      restoreSnapshot: true,
      snapshot: { state: 'captured', dirName: snapshot.dirName }
    })
  })

  it('refuses a third activation record rather than guessing ownership', () => {
    const changed = { ...before, active: '0.3.0+other' }

    expect(planOrcadActivationRecovery(prepared(), changed)).toMatchObject({
      action: 'refuse',
      code: 'orcad_recovery_activation_record_changed'
    })
  })

  it('round-trips every durable rollback checkpoint with an exact commit record', () => {
    const recordBefore = {
      ...before,
      previous: '0.0.9+target',
      snapshot: {
        dirName: 'pre-0.1.0+old-500',
        takenBeforeVersion: '0.1.0+old',
        readableByVersion: '0.0.9+target',
        takenAt: new Date(500).toISOString()
      }
    }
    const transaction = createOrcadRollbackTransaction({
      transactionId,
      incumbentVersion: '0.1.0+old',
      targetVersion: '0.0.9+target',
      recordBefore,
      recordAfter: withRolledBackVersion(recordBefore, new Date(1_000)),
      rescueDirName: 'rollback-rescue-0.1.0+old-1000',
      now: new Date(1_000)
    })
    const stopped = withOrcadRollbackPhase(transaction, 'incumbent-stopped', new Date(2_000))
    const rescued = withOrcadRollbackRescue(stopped, 'captured', new Date(3_000))
    const restored = withOrcadRollbackPhase(rescued, 'rollback-state-restored', new Date(4_000))
    const ready = withOrcadRollbackPhase(restored, 'target-ready', new Date(5_000))

    expect(parseOrcadActivationTransaction(serializeOrcadActivationTransaction(ready))).toEqual({
      state: 'ok',
      transaction: ready
    })
  })

  it('rejects rollback progress without a durable rescue verdict', () => {
    const recordBefore = { ...before, previous: '0.0.9+target' }
    const transaction = createOrcadRollbackTransaction({
      transactionId,
      incumbentVersion: '0.1.0+old',
      targetVersion: '0.0.9+target',
      recordBefore,
      recordAfter: withRolledBackVersion(recordBefore, new Date(1_000)),
      rescueDirName: 'rollback-rescue-0.1.0+old-1000',
      now: new Date(1_000)
    })

    expect(
      parseOrcadActivationTransaction(
        JSON.stringify({ ...transaction, phase: 'rollback-state-restored' })
      )
    ).toMatchObject({
      state: 'unreadable',
      reason: expect.stringContaining('durable rescue verdict')
    })
  })
})
