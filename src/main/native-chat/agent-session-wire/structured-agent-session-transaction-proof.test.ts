import { expect, it, vi } from 'vitest'
import type { JournalTransactionObservation } from '../agent-session-journal/journal-database'
import {
  loadTestJournal,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from '../../runtime/agent-session-record-store-test-harness'
import { observedReceipt } from './structured-agent-session-operation-settlement'
import { createTestParams } from './structured-agent-session-create-test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  restTestSend,
  REST_TEST_CALLER as CALLER
} from './structured-agent-session-rest-test-rig'

it('keeps real COMMIT proof ahead of observers and distinguishes rollback from an unresolved receipt attempt', async () => {
  const hold = Promise.withResolvers<void>()
  const rig = await createRestTestRig({
    setupHold: () => hold.promise,
    idleSweep: { intervalMs: 60_000 }
  })
  const observation: JournalTransactionObservation = { disposition: 'not-attempted' }
  const foundingReceipt = rig.store.founding.receipt.bind(rig.store.founding)
  vi.spyOn(rig.store.founding, 'receipt').mockImplementation((request) => ({
    ...foundingReceipt(request),
    transactionObservation: observation
  }))
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const seen: unknown[] = []
  rig.store.onFirstRecord(() => {
    seen.push({
      disposition: observation.disposition,
      adopted: rig.store.getRecord(SESSION) !== null,
      saved: loadTestJournal(rig.root, SESSION)?.state.submissions.size
    })
    throw new Error('observer failed after the actual COMMIT')
  })
  const nextObserver = vi.fn()
  rig.store.onFirstRecord(nextObserver)
  try {
    const firstMessage = { clientMessageId: hostTestOperationId(), body: hostTestMessage('A') }
    const params = createTestParams(firstMessage)
    const publishTab = vi.fn(async () => {})
    expect(await rig.host.create(CALLER, params, { firstMessage, publishTab })).toMatchObject({
      ok: true
    })
    expect(seen).toEqual([{ disposition: 'committed', adopted: true, saved: 1 }])
    expect(nextObserver).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledWith(
      '[agent-session-founding] first-record observer failed',
      expect.any(Error)
    )
    expect(publishTab).toHaveBeenCalledOnce()
    const founded = await readPersistedTestAgentSessionStore(rig.root)
    expect(Object.values(founded.operations)).toContainEqual(
      expect.objectContaining({
        callerKey: CALLER.callerKey,
        operationId: params.envelope.clientOperationId,
        fingerprint: params.envelope.payloadFingerprint,
        outcome: { status: 'succeeded', sessionId: SESSION }
      })
    )
    expect(
      rig.host
        .collaboratorsForTests()
        .sessions.get(SESSION)
        ?.journal.submission(firstMessage.clientMessageId)
    ).toBeDefined()

    const database = openTestJournalHostDatabase(rig.root)
    const makeReceipt = async () => {
      const operationId = hostTestOperationId()
      await rig.store.admitOperation({
        callerKey: CALLER.callerKey,
        operationId,
        fingerprint: 'proof',
        now: NOW
      })
      const transactionObservation: JournalTransactionObservation = { disposition: 'not-attempted' }
      const receipt = rig.store.operationOutcomeReceipt({
        callerKey: CALLER.callerKey,
        operationId,
        outcome: { status: 'succeeded', sessionId: SESSION }
      })
      return { operationId, transactionObservation, receipt }
    }
    const rolledBack = await makeReceipt()
    const rollbackReceipt = observedReceipt(rig.store, {
      ...rolledBack.receipt,
      transactionObservation: rolledBack.transactionObservation,
      write: (db, row) => {
        rolledBack.receipt.write(db, row)
        throw new Error('refused before COMMIT')
      }
    })
    await expect(rig.store.commitOperationReceipt(rollbackReceipt)).rejects.toThrow(
      'refused before COMMIT'
    )
    expect(rolledBack.transactionObservation.disposition).toBe('not-committed')
    expect(rollbackReceipt.isCommitted()).toBe(false)
    expect(
      (await openTestAgentSessionRecordStore(rig.root)).getOperationRow(
        CALLER.callerKey,
        rolledBack.operationId
      )?.outcome.status
    ).toBe('pending')

    const adopted = await makeReceipt()
    const adoptedReceipt = observedReceipt(rig.store, {
      ...adopted.receipt,
      transactionObservation: adopted.transactionObservation,
      committed: () => {
        adopted.receipt.committed()
        throw new Error('mandatory delegate returned an error after adoption')
      }
    })
    await expect(rig.store.commitOperationReceipt(adoptedReceipt)).rejects.toThrow(
      'mandatory delegate returned an error after adoption'
    )
    expect(adopted.transactionObservation.disposition).toBe('committed')
    expect(adoptedReceipt.isCommitted()).toBe(true)
    expect(rig.store.getOperationRow(CALLER.callerKey, adopted.operationId)?.outcome.status).toBe(
      'succeeded'
    )

    const uncertain = await makeReceipt()
    const uncertainReceipt = observedReceipt(rig.store, {
      ...uncertain.receipt,
      transactionObservation: uncertain.transactionObservation
    })
    const exec = database.db.exec.bind(database.db)
    const failAfterCommit = vi.spyOn(database.db, 'exec').mockImplementation((sql) => {
      exec(sql)
      if (sql === 'COMMIT') {
        failAfterCommit.mockRestore()
        throw new Error('COMMIT returned an indeterminate error after actually committing')
      }
    })
    await expect(rig.store.commitOperationReceipt(uncertainReceipt)).rejects.toThrow(
      'COMMIT returned an indeterminate error'
    )
    expect(database.db.isTransaction).toBe(false)
    expect(uncertain.transactionObservation.disposition).toBe('unresolved')
    expect(uncertainReceipt.isCommitted()).toBe(false)
    const saved = await readPersistedTestAgentSessionStore(rig.root)
    expect(Object.values(saved.operations)).toContainEqual(
      expect.objectContaining({
        operationId: uncertain.operationId,
        outcome: { status: 'succeeded', sessionId: SESSION }
      })
    )
    expect(rig.store.getOperationRow(CALLER.callerKey, uncertain.operationId)?.outcome.status).toBe(
      'pending'
    )
    expect(await rig.host.send(CALLER, restTestSend('ordinary B'))).toMatchObject({ ok: true })
    const stored = loadTestJournal(rig.root, SESSION)
    expect(
      [...stored!.state.submissions.values()].map((entry) => entry.clientMessageId)
    ).toHaveLength(2)
    expect(stored?.state.submissions.has(firstMessage.clientMessageId)).toBe(true)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    await rig.host.close(SESSION, 'evict')
    hold.resolve()
    await rig.dispose()
  }
})
