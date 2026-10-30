import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTestParams } from './structured-agent-session-create-test-fixture'
import {
  hostTestMessage,
  hostTestOperationId,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import { mailTestResources } from '../../runtime/orchestration/mail-handoff.test-fixture'
import { observeMailSqlWork } from '../../runtime/orchestration/mail-sql-work.test-support'
import { ordinaryMailCreationId } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { selectMailCreationOperation } from '../../runtime/orchestration/structured-mail-operation-identity'
import {
  readMailCreationHistory,
  observeMailCreationHistory
} from '../../runtime/orchestration/structured-mail-creation-history'
import { sendAgentTurn } from '../../runtime/orchestration/send-agent-turn'
import { structuredMailSource } from '../../runtime/orchestration/structured-mail-source'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import { eventually } from './structured-agent-session-queued-message-rig.test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  rig,
  db,
  bridge,
  clock,
  journal,
  card,
  complete,
  installMailQueueLifecycle,
  openMailQueueSource,
  mailWorkCounts
} from './structured-agent-session-mail-queue.test-fixture'
installMailQueueLifecycle()
afterEach(() => vi.restoreAllMocks())

it('recovers unknown creation and an occupied old identity through stable ordinary receipts across lost stamp, controls and file-backed reopen', async () => {
  const root = mailTestResources('ordinary-mail-recovery-').directory()
  bridge.resetForDatabaseChange()
  db.close()
  openMailQueueSource(join(root, 'source.db'))
  await rig.workingSend()
  // Carried private columns, including malformed old bytes, are inert and remain private.
  db.db.exec(
    'ALTER TABLE messages ADD COLUMN creation_proof TEXT; ALTER TABLE runs ADD COLUMN mail_creation_domain TEXT'
  )
  const a = db.insertMessage({
    id: 'old-unknown-source',
    from: 'worker',
    to: 'consumer',
    subject: 'unknown creation is not Stop order'
  })
  db.db
    .prepare('UPDATE messages SET creation_proof = ? WHERE id = ?')
    .run('{old-private-value}', a.id)
  const canonical = ordinaryMailCreationId(a)
  const database = rig.host.deps.journalDatabase.db
  // An accepted legacy locator whose original body is gone is no positive, not permission to hold.
  database
    .prepare(`INSERT INTO agent_session_command_receipts
    (operation_id,session_id,caller_key,method,fingerprint,status,result_json,accepted_at)
    VALUES (?, ?, 'trusted-local:orchestration:old', 'agentSession.send', 'old', 'accepted', ?, 1)`)
    .run(
      hostTestOperationId(),
      SESSION,
      JSON.stringify({ kind: 'queued-draft', messageId: 'missing-original' })
    )
  database
    .prepare(`INSERT INTO agent_session_command_receipts
    (operation_id,session_id,caller_key,method,fingerprint,status,result_json,accepted_at)
    VALUES (?, ?, 'other-client', 'agentSession.send', 'old-fingerprint', 'accepted', ?, 1)`)
    .run(
      canonical,
      SESSION,
      JSON.stringify({ kind: 'queued-draft', messageId: 'unrelated-original' })
    )
  const blocker = database
    .prepare('SELECT * FROM agent_session_command_receipts WHERE operation_id = ?')
    .get(canonical)
  const choice = selectMailCreationOperation(rig.host, a)
  expect(choice.state).toBe('absent')
  expect(choice.operationId).not.toBe(canonical)
  expect(selectMailCreationOperation(rig.host, a)).toEqual(choice)
  const stamp = vi.spyOn(db, 'markAsDelivered').mockImplementationOnce(() => {
    throw new Error('lost stamp after acceptance')
  })
  bridge.deliverForHandle('consumer')
  await eventually(() => expect(journal().queuedMessages.get(choice.operationId)).toBeTruthy())
  stamp.mockRestore()
  bridge.retryForHandle('consumer')
  await eventually(() => expect(db.getMessageById(a.id)?.delivered_at).not.toBeNull())
  expect(db.getMessageById(a.id)).not.toHaveProperty('creation_proof')
  expect(selectMailCreationOperation(rig.host, a)).toMatchObject({
    operationId: choice.operationId,
    state: 'accepted'
  })
  expect(await rig.deleteQueued(choice.operationId)).toMatchObject({ ok: true })
  db.markAsRead([a.id])
  db.resetTasks()
  bridge.resetForDatabaseChange()
  db.close()
  openMailQueueSource(join(root, 'source.db'))
  await rig.restartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  db.db.prepare('UPDATE messages SET delivered_at = NULL WHERE id = ?').run(a.id)
  const sends = vi.spyOn(rig.host, 'send')
  bridge.deliverForHandle('consumer')
  await eventually(() => expect(db.getMessageById(a.id)?.delivered_at).not.toBeNull())
  expect(sends).not.toHaveBeenCalled()
  expect(
    rig.host.deps.journalDatabase.db
      .prepare('SELECT * FROM agent_session_command_receipts WHERE operation_id = ?')
      .get(canonical)
  ).toEqual(blocker)
  expect(selectMailCreationOperation(rig.host, a)).toMatchObject({
    operationId: choice.operationId,
    state: 'accepted'
  })
  expect(journal().queuedMessages.get(choice.operationId)).toMatchObject({ state: 'withdrawn' })
  expect(
    db.db.prepare('SELECT creation_proof FROM messages WHERE id = ?').get(a.id)?.creation_proof
  ).toBe('{old-private-value}')
})

it('creates an ordinary held card for unknown Stop order, keeps local pending order through reopen and imports without a creation certificate', async () => {
  const root = mailTestResources('mail-source-order-').directory()
  bridge.resetForDatabaseChange()
  db.close()
  const path = join(root, 'source.db')
  openMailQueueSource(path)
  await rig.workingSend()
  await rig.stop()
  const local = db.insertMessage({
    id: 'stable-no-birth',
    from: 'worker',
    to: 'not-native-yet',
    subject: 'local pending'
  })
  const unknown = db.insertMessage({
    id: 'legacy-unknown-order',
    from: 'worker',
    to: 'consumer',
    subject: 'held ordinary report'
  })
  db.db.prepare('UPDATE messages SET ordering_origin = NULL WHERE id = ?').run(unknown.id)
  bridge.resetForDatabaseChange()
  db.close()
  openMailQueueSource(path)
  bridge.attachDatabase(db)
  bridge.deliverForHandle('consumer')
  const unknownId = await card(unknown.id)
  expect(await rig.handoff(unknownId)).toBeUndefined()
  db.db.exec('BEGIN IMMEDIATE')
  db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('consumer', local.id)
  db.db.exec('ROLLBACK')
  await clock.observe(50)
  expect(db.getMessageById(local.id)?.to_handle).toBe('not-native-yet')
  db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('consumer', local.id)
  const localId = await card(local.id)
  await eventually(async () => expect(await rig.handoff(localId)).toBeDefined())
  await complete(await rig.handoffId(localId))
  expect(await rig.handoff(unknownId)).toBeUndefined()
  const run = db.createRun({ objective: 'home', coordinatorHandle: null, coordinatorPaneKey: null })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 3,
    taskId: db.createTask({ spec: 'remote', runId: run.id }).id,
    startOptions: {},
    federation: {
      environmentId: 'peer',
      environmentName: 'peer',
      peerFingerprint: 'authenticated-peer',
      protocolVersion: 3
    }
  })
  const imported = db.importFederatedRelayItem({
    dispatchId: dispatch.id,
    sequence: 1,
    message: {
      id: 'home-message',
      runId: run.id,
      from: 'remote-worker',
      to: 'consumer',
      subject: 'full report',
      body: 'complete body',
      type: 'status',
      priority: 'normal'
    },
    lifecycle: { kind: 'none' }
  }).message
  const importedId = await card(imported.id)
  expect(imported).not.toHaveProperty('creation_proof')
  expect(run).not.toHaveProperty('mail_creation_domain')
  expect(db.getMessageById(imported.id)?.ordering_origin).toBe('imported')
  expect(await rig.handoff(importedId)).toBeUndefined()
  expect(await rig.resume()).toMatchObject({ ok: true })
  for (const id of [unknownId, importedId]) {
    await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
    await complete(await rig.handoffId(id))
  }
})

it.each([100, 1000])(
  'indexes populated original history once at N=%i, applies exact nonmail deltas and stamps a current READ member without source-domain subscriptions',
  async (count) => {
    await rig.workingSend()
    bridge.resetForDatabaseChange()
    const sources = db.insertMessages(
      Array.from({ length: count }, (_, n) => ({
        id: `old-${n}`,
        from: 'worker',
        to: 'consumer',
        subject: `retained-${n}`
      }))
    )
    const first = sources[0]!
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('original-D', first.id)
    db.markAsRead(sources.map((s) => s.id))
    const create = async (sessionId: string) => {
      expect(
        await rig.host.create(
          { callerKey: 'real-client' },
          createTestParams(undefined, {
            envelope: {
              sessionId,
              clientOperationId: hostTestOperationId(),
              expectedRuntimeFence: null,
              payloadFingerprint: '0'.repeat(64)
            }
          })
        )
      ).toMatchObject({ ok: true })
    }
    const former = 'original-D'
    const x = 'populated-X'
    await create(former)
    await create(x)
    const queue = async (
      sessionId: string,
      body: ReturnType<typeof hostTestMessage>,
      operationId = hostTestOperationId()
    ) => {
      expect(
        await sendAgentTurn({
          kind: 'structured-session',
          host: rig.host,
          sessionId,
          callerKey: 'trusted-local:orchestration:old',
          turn: {
            body,
            operationId,
            expectedRuntimeFence: rig.store.getRecord(sessionId)!.lease.runtimeFence,
            delivery: 'queue',
            queueAlways: true
          }
        })
      ).toMatchObject({ kind: 'queued' })
      return operationId
    }
    const from = structuredMailSource({
      db,
      mailboxHandle: 'former-route',
      dispatchId: null,
      message: first,
      senderName: () => null
    })
    if (from.orchestration?.message !== 'mail-notice') {
      throw new Error('mail attribution missing')
    }
    const batch = {
      ...hostTestMessage('original batch'),
      from: {
        ...from,
        orchestration: {
          ...from.orchestration,
          messages: sources
            .slice(1)
            .map((s) => ({ messageId: s.id, runId: s.run_id, from: s.from_handle }))
        }
      }
    }
    await queue(former, batch)
    const xJournal = rig.host.collaboratorsForTests().sessions.get(x)!.journal
    for (let n = 0; n < count; n++) {
      await xJournal.appendItem(
        { provider: 'orca', clientMessageId: `history-${n}` },
        { kind: 'status', text: `retained X history ${n}` },
        { fence: rig.store.getRecord(x)!.lease.runtimeFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    const database = rig.host.deps.journalDatabase.db
    const cold = observeMailSqlWork(
      database,
      (sql) => sql.startsWith('SELECT session_id, epoch, seq, row_json FROM journal_rows'),
      'row_json'
    )
    const history = readMailCreationHistory(rig.host, SESSION)
    expect(history.members.size).toBe(count - 1)
    // Establish the native recovery owner before the tested route/member commits.
    bridge.deliverForHandle('consumer')
    await clock.observe(50)
    expect(cold.count()).toBeGreaterThanOrEqual(count)
    const coldCount = cold.count(),
      coldBytes = cold.evaluatedBytes()
    let notices = 0
    const stop = observeMailCreationHistory(rig.host, (keys) => {
      notices += keys.size
    })
    const receiptReads = vi.spyOn(rig.store, 'readCommandReceipt')
    for (let k = 0; k < 4; k++) {
      await queue(x, hostTestMessage(`unrelated task preamble ${k}`))
      await clock.observe(20)
    }
    expect(cold.count()).toBe(coldCount)
    expect(notices).toBe(0)
    expect(receiptReads.mock.calls.length).toBeLessThanOrEqual(8)
    stop()
    // Coherent capture survives the no-listener interval and duplicate member contributions.
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('consumer', first.id)
    await clock.observe(50)
    expect(db.getMessageById(first.id)).toMatchObject({ read: 1, delivered_at: null })
    await eventually(() =>
      expect(mailWorkCounts()).toMatchObject({
        pendingIds: 0,
        reverseIds: 0,
        attempts: 0,
        deferred: 0
      })
    )
    const sends = vi.spyOn(rig.host, 'send')
    const positive = { ...hostTestMessage('late original report'), from }
    let failed = false
    let delivered = 0
    const retryStop = observeMailCreationHistory(rig.host, (keys) => {
      if (!keys.size) {
        return
      }
      // A consumer can read during propagation; it must not recurse into this same capture.
      expect(readMailCreationHistory(rig.host, SESSION).members.size).toBe(count)
      if (!failed) {
        failed = true
        throw new Error('lost exact positive notification')
      }
      delivered++
    })
    const firstOperation = await queue(former, positive)
    await eventually(() => expect(delivered).toBe(1))
    retryStop()
    const secondOperation = await queue(former, positive)
    await clock.observe(20)
    expect(readMailCreationHistory(rig.host, SESSION).members.size).toBe(count)
    database
      .prepare('DELETE FROM agent_session_command_receipts WHERE operation_id = ?')
      .run(firstOperation)
    await clock.observe(20)
    expect(readMailCreationHistory(rig.host, SESSION).members.size).toBe(count)
    const original = rig.host
      .collaboratorsForTests()
      .sessions.get(former)!
      .journal.queuedMessages.get(secondOperation)!
    expect(original.body.from?.orchestration).toBeDefined()
    await eventually(() =>
      expect(db.getMessageById(first.id)).toMatchObject({
        read: 1,
        to_handle: 'consumer',
        delivered_at: expect.any(String)
      })
    )
    expect(
      sends.mock.calls.filter(([, params]) => params.envelope.sessionId === SESSION)
    ).toHaveLength(0)
    const coldAfter = cold.count()
    const readsAfter = receiptReads.mock.calls.length
    for (const source of sources) {
      db.db.prepare('UPDATE messages SET delivered_at = NULL WHERE id = ?').run(source.id)
    }
    await clock.observe(100)
    expect(cold.count()).toBe(coldAfter)
    expect(receiptReads.mock.calls.length).toBe(readsAfter)
    console.info(
      'positive-original-work',
      JSON.stringify({
        count,
        coldRows: coldCount,
        coldBytes,
        hotFullInventories: cold.count() - coldCount,
        receiptReads: readsAfter,
        notices
      })
    )
    cold.verify()
    cold.restore()
  }
)

it('reconciles a saved random multi-member batch after ordinary Delete and source/native restart without recreating either report', async () => {
  const root = mailTestResources('legacy-batch-reopen-').directory()
  bridge.resetForDatabaseChange()
  db.close()
  openMailQueueSource(join(root, 'source.db'))
  await rig.workingSend()
  const [a, b] = db.insertMessages([
    { from: 'worker', to: 'consumer', subject: 'old batch first' },
    { from: 'worker', to: 'consumer', subject: 'old batch second' }
  ])
  if (!a || !b) {
    throw new Error('legacy members missing')
  }
  const from = structuredMailSource({
    db,
    mailboxHandle: 'consumer',
    dispatchId: null,
    message: a,
    senderName: () => null
  })
  if (from.orchestration?.message !== 'mail-notice') {
    throw new Error('legacy attribution missing')
  }
  const operationId = hostTestOperationId()
  expect(
    await sendAgentTurn({
      kind: 'structured-session',
      host: rig.host,
      sessionId: SESSION,
      callerKey: 'trusted-local:orchestration:old-random-batch',
      turn: {
        body: {
          ...hostTestMessage('original two-worker report'),
          from: {
            ...from,
            orchestration: {
              ...from.orchestration,
              messages: [a, b].map((row) => ({
                messageId: row.id,
                runId: row.run_id,
                from: row.from_handle
              }))
            }
          }
        },
        operationId,
        expectedRuntimeFence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
        delivery: 'queue',
        queueAlways: true
      }
    })
  ).toMatchObject({ kind: 'queued' })
  expect(journal().queuedMessages.get(operationId)).toMatchObject({ state: 'waiting' })
  expect(await rig.deleteQueued(operationId)).toMatchObject({ ok: true })
  expect(journal().queuedMessages.get(operationId)).toMatchObject({ state: 'withdrawn' })
  db.markAsRead([a.id, b.id])
  db.resetTasks()
  bridge.resetForDatabaseChange()
  db.close()
  openMailQueueSource(join(root, 'source.db'))
  await rig.coldReopenNativeDatabase()
  setStructuredAgentSessionHost(rig.host)
  await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  const sends = vi.spyOn(rig.host, 'send')
  // Initial recovery is a separate trigger from the autonomous changed-READ case above.
  bridge.deliverForHandle('consumer')
  await eventually(() => {
    for (const row of [a, b]) {
      expect(db.getMessageById(row.id)).toMatchObject({ read: 1, delivered_at: expect.any(String) })
      expect(journal().queuedMessages.get(ordinaryMailCreationId(row))).toBeNull()
    }
  })
  expect(journal().queuedMessages.get(operationId)).toMatchObject({ state: 'withdrawn' })
  expect(rig.store.readCommandReceipt({ kind: 'global' }, operationId)).toMatchObject({
    verdict: 'readable',
    receipt: { status: 'accepted', result: { kind: 'queued-draft', messageId: operationId } }
  })
  expect(sends).not.toHaveBeenCalled()
})
