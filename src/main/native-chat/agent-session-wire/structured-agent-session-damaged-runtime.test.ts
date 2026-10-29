import {
  composeStructuredLaunch,
  composeStructuredLaunchRead
} from '../../runtime/structured-agent-launch-composition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { afterEach, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { setOptionPlan } from './structured-agent-session-mutation-plans'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
let restored: StructuredAgentSessionHost | undefined
afterEach(async () => {
  await restored?.flushAllStreamedEvents()
  await rig?.dispose()
})

it('replays a saved send and its conflict but refuses fresh send, Stop and metadata before any new work', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  await rig.store.replaceSessionOptions({
    sessionId: SESSION,
    fence: 1,
    options: { model: 'kept-model', effort: 'high' },
    now: 1800000000000
  })
  const body = hostTestMessage('saved message')
  const envelope = rig.envelope({ body }, 'agentSession.send', hostTestOperationId())
  const params = { envelope, body, userSend: true as const }
  const accepted = await rig.host.send(CALLER, params)
  expect(accepted).toMatchObject({ ok: true })
  expect(
    rig.store.readCommandReceipt({ kind: 'global' }, envelope.clientOperationId)
  ).toMatchObject({ verdict: 'readable' })
  await rig.host.flushAllStreamedEvents()
  damageFloor(rig.root)
  const store = await openTestAgentSessionRecordStore(rig.root)
  expect(store.readCommandReceipt({ kind: 'global' }, envelope.clientOperationId)).toMatchObject({
    verdict: 'readable'
  })
  restored = new StructuredAgentSessionHost({ ...rig.host.deps, store })
  expect(await restored.readOptions(SESSION, { readsWithoutModel: true })).toMatchObject({
    current: { model: 'kept-model', effort: 'high' }
  })
  const starts = rig.starts.mock.calls.length
  const sends = rig.dispatch.mock.calls.length
  expect(await restored.revealSession(SESSION)).toMatchObject({ sessionId: SESSION })
  expect(await restored.send(CALLER, params)).toMatchObject({
    ok: true,
    replayed: true,
    fence: store.getConversation(SESSION)?.currentFence,
    value: { clientMessageId: envelope.clientOperationId }
  })
  const changed = hostTestMessage('different message')
  expect(
    await restored.send(CALLER, {
      ...params,
      body: changed,
      envelope: rig.envelope({ body: changed }, 'agentSession.send', envelope.clientOperationId)
    })
  ).toMatchObject({ ok: false, refusal: { code: 'agent_session_operation_conflict' } })
  expect(
    await restored.send(CALLER, {
      ...params,
      envelope: rig.envelope({ body }, 'agentSession.send', hostTestOperationId())
    })
  ).toMatchObject({ ok: false, refusal: { details: { reason: 'recordUnreadable' } } })
  expect(
    await restored.cancel(CALLER, {
      envelope: rig.envelope({}, 'agentSession.cancel', hostTestOperationId())
    })
  ).toMatchObject({ ok: false, refusal: { details: { reason: 'recordUnreadable' } } })
  await expect(store.setConversationName(SESSION, 'changed')).rejects.toMatchObject({
    refusal: { details: { reason: 'recordUnreadable' } }
  })
  expect(rig.starts).toHaveBeenCalledTimes(starts)
  expect(rig.dispatch).toHaveBeenCalledTimes(sends)
  expect((await restored.journalSnapshot(SESSION)).submissions).toHaveLength(1)
  const close = vi.spyOn(restored.deps.adapter, 'closeSession')
  const release = vi.spyOn(restored.deps.adapter, 'releaseAcquisition')
  const closes = close.mock.calls.length
  const releases = release.mock.calls.length
  expect(await restored.sleepWorkspace('workspace-1', true)).toEqual({
    stoppedSessionIds: [],
    failures: [{ sessionId: SESSION, reason: 'stop-unverifiable' }]
  })
  expect(close).toHaveBeenCalledTimes(closes)
  expect(release).toHaveBeenCalledTimes(releases)
})

it('answers a recorded ledger result without a preparation hook before requiring fresh authority', async () => {
  rig = await createQueuedMessageTestRig()
  const fields = { key: 'model', value: 'gpt-5' }
  const envelope = rig.envelope(fields, 'agentSession.setOption', hostTestOperationId())
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const request = {
    ...rig.host.deps,
    callerKey: CALLER.callerKey,
    envelope,
    plan: setOptionPlan(fields),
    journal: () => journal,
    publish: () => {},
    now: () => 1800000000000
  }
  expect(await admitAndRunAgentSessionMutation(request)).toMatchObject({ ok: true })
  await rig.store.transitionHandoff(SESSION, (record) => ({
    ...record,
    lease: { ...record.lease, claimStatus: 'released', ownerProcess: null }
  }))
  const pendingEnvelope = { ...envelope, clientOperationId: hostTestOperationId() }
  expect(
    await rig.store.admitMutationOperation({
      callerKey: CALLER.callerKey,
      envelope: pendingEnvelope,
      hostFingerprint: pendingEnvelope.payloadFingerprint,
      now: request.now(),
      conversationWrite: true
    })
  ).toMatchObject({ admission: { decision: 'admit' } })
  damageFloor(rig.root)
  const store = await openTestAgentSessionRecordStore(rig.root)
  expect(await admitAndRunAgentSessionMutation({ ...request, store })).toMatchObject({
    ok: true,
    replayed: true,
    value: fields
  })
  expect(
    await admitAndRunAgentSessionMutation({ ...request, store, envelope: pendingEnvelope })
  ).toMatchObject({ ok: false, refusal: { details: { reason: 'recordUnreadable' } } })
  await store.recordOperationOutcome({
    callerKey: CALLER.callerKey,
    operationId: pendingEnvelope.clientOperationId,
    outcome: { status: 'unknown' }
  })
  expect(
    await admitAndRunAgentSessionMutation({ ...request, store, envelope: pendingEnvelope })
  ).toMatchObject({ ok: false, refusal: { code: 'agent_session_operation_unknown' } })
  await store.recordOperationOutcome({
    callerKey: CALLER.callerKey,
    operationId: pendingEnvelope.clientOperationId,
    outcome: {
      status: 'failed',
      code: 'agent_session_conflict',
      details: { reason: 'claimConflicted' }
    }
  })
  expect(
    await admitAndRunAgentSessionMutation({ ...request, store, envelope: pendingEnvelope })
  ).toMatchObject({ ok: false, refusal: { code: 'agent_session_conflict' } })
  const operation = {
    callerKey: CALLER.callerKey,
    envelope,
    hostFingerprint: envelope.payloadFingerprint,
    now: request.now()
  }
  expect(await store.admitMutationOperation(operation)).toMatchObject({
    admission: { decision: 'replay' },
    record: { currentFence: store.getConversation(SESSION)?.currentFence }
  })
  expect(
    await store.admitMutationOperation({
      ...operation,
      hostFingerprint: 'changed',
      envelope: { ...envelope, payloadFingerprint: 'changed' }
    })
  ).toMatchObject({
    admission: { decision: 'refused', refusal: { code: 'agent_session_operation_conflict' } }
  })
  await expect(
    store.admitMutationOperation({
      ...operation,
      envelope: { ...envelope, clientOperationId: hostTestOperationId() },
      conversationWrite: true
    })
  ).rejects.toMatchObject({ refusal: { details: { reason: 'recordUnreadable' } } })
  expect(
    await store.admitMutationOperation({
      ...operation,
      envelope: { ...envelope, sessionId: 'missing-chat' }
    })
  ).toBeNull()
})

function damageFloor(root: string): void {
  openTestJournalHostDatabase(root)
    .db.prepare(
      "UPDATE agent_session_records SET record_json = json_set(record_json, '$.lease.minimumNextFence', 'bad') WHERE session_id = ?"
    )
    .run(SESSION)
}

it('refuses launch and probe results when saved authority changes during preparation', async () => {
  rig = await createQueuedMessageTestRig()
  const identity = {
    sessionId: SESSION,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'codex',
    providerHandle: null
  }
  let current = rig.store
  const sources = {
    store: {
      selectWritableRecord: (id: string) => current.selectWritableRecord(id),
      requireWritableRecord: (id: string) => current.requireWritableRecord(id),
      pinLaunchDirectory: rig.store.pinLaunchDirectory
    },
    resolveWorkspacePath: async () => rig!.root,
    resolveBaseEnvironment: async () => ({}),
    resolveAgentEnvironment: async () => ({})
  }
  const part = async () => {
    damageFloor(rig!.root)
    current = await openTestAgentSessionRecordStore(rig!.root)
    return { launch: { command: '/fixture/codex' }, env: {}, inheritedEnvToDelete: [] }
  }
  await expect(
    composeStructuredLaunch(
      CODEX_STRUCTURED_AGENT,
      sources,
      part
    )({ identity, spawnToken: 'fixture-token' })
  ).rejects.toMatchObject({ refusal: { details: { reason: 'recordUnreadable' } } })
  current = rig.store
  await expect(
    composeStructuredLaunchRead(CODEX_STRUCTURED_AGENT, sources, part)(identity)
  ).rejects.toMatchObject({ refusal: { details: { reason: 'recordUnreadable' } } })
})
