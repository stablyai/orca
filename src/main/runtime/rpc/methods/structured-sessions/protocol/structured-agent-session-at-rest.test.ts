import { AgentSessionJournal } from '../../../../../native-chat/agent-session-journal/journal-store'
import { seedQueuedRigLegacyJournal } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-legacy-journal.test-fixture'
import { REST_TEST_CALLER } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig.test-fixture'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../../../shared/agent-session/structured-agent-session-reducer'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
vi.mock('node:fs/promises', { spy: true })
import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../../../../shared/agent-session/options/agent-session-optional-model-capability'
import { agentSessionOperationKey } from '../../../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../../../shared/agent-session/options/agent-session-option-catalog-claude-codex'
import {
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks
} from '../../../../../../shared/agent-session/options/structured-agent-session-options'
import {
  hostTestAttachParams,
  hostTestOperationId,
  HOST_TEST_SESSION as SESSION
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

import {
  editPersistedTestAgentSessionStore,
  withTestAgentSessionDatabase
} from '../../../../agent-session/records/agent-session-record-store-test-harness'
import type { RpcResponse } from '../../../core'
import { journalSqlReads } from '../../../../../native-chat/agent-session-journal/journal-sql-reads'

import {
  CLIENT,
  fixture,
  call,
  restingChat
} from './structured-agent-session-rest-contract-test-fixture'

function optionRequest(value: string, sessionId = SESSION) {
  const fields = { key: 'model', value }
  return {
    ...fields,
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fixture.rig.store.getRecord(sessionId)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.setOption',
        sessionId,
        fields
      })
    }
  }
}

it('commits a legacy no-choice answer before reply and replays it after upgrade and a real pick', async () => {
  await restingChat()
  const record = fixture.rig.store.getRecord(SESSION)!
  await fixture.rig.host.readOptions(SESSION)
  await fixture.rig.store.replaceSessionOptions({
    sessionId: SESSION,
    fence: record.lease.runtimeFence,
    options: { effort: 'high' },
    now: fixture.rig.clock.now
  })
  const params = optionRequest('')
  const inert = { key: 'model', value: '', options: {} }
  expect((await call('agentSession.setOption', params))[0]).toMatchObject({
    result: { ok: true, replayed: false, value: inert }
  })
  expect(fixture.rig.store.getRecord(SESSION)?.options).toEqual({ effort: 'high' })
  expect(
    fixture.rig.store.getOperationRow('device-1', params.envelope.clientOperationId)?.outcome
  ).toMatchObject({ optionResult: { version: 1, ...inert } })
  const warm = commitStructuredAgentSessionOptionValues(
    createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
    { model: 'gpt-saved', effort: 'high' }
  )
  expect(structuredAgentSessionOptionPicks(warm, inert.options)).toEqual([])
  const choice = await call('agentSession.setOption', optionRequest('gpt-new'))
  expect(choice[0]).toMatchObject({
    result: {
      ok: true,
      value: { value: 'gpt-new', options: { model: 'gpt-new', effort: 'high' } }
    }
  })
  expect(
    structuredAgentSessionOptionPicks(warm, { model: 'gpt-new', effort: 'high' })
  ).toHaveLength(2)
  expect((await call('agentSession.setOption', optionRequest('')))[0]).toMatchObject({
    result: { ok: true, replayed: false, value: inert }
  })
  await fixture.rig.restart()
  setStructuredAgentSessionHost(fixture.rig.host)
  expect(
    (
      await call('agentSession.setOption', params, {
        ...CLIENT,
        clientCapabilities: [
          ...CLIENT.clientCapabilities,
          AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
        ]
      })
    )[0]
  ).toMatchObject({ result: { ok: true, replayed: true, value: inert } })
  expect(fixture.rig.store.getRecord(SESSION)?.options).toEqual({
    model: 'gpt-new',
    effort: 'high'
  })
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  expect(fixture.rig.adapter.readOptions).not.toHaveBeenCalled()
})

it('preserves a v1.4.223 live ACP acceptance without reclassifying it as no-choice', async () => {
  await restingChat()
  // Captured after the old live adapter performed an empty request and reopened its database.
  const row = {
    callerKey: 'device-1',
    operationId: '1800000000000-0000000000000000000000000000ac01',
    fingerprint: 'df56281bb29dcb9d435ba37cd35c0704edcfad8e4cd94c9d85ebf8efe78d8935',
    operationTimestamp: 1800000000000,
    recordedAt: 1800000000000,
    expiresAt: 1800086700000,
    outcome: { status: 'succeeded' as const, sessionId: 'session-alpha-1' }
  }
  const envelope = {
    sessionId: 'session-alpha-1',
    clientOperationId: '1800000000000-0000000000000000000000000000ac01',
    expectedRuntimeFence: 7,
    payloadFingerprint: 'df56281bb29dcb9d435ba37cd35c0704edcfad8e4cd94c9d85ebf8efe78d8935'
  }
  const sessionId = envelope.sessionId
  await editPersistedTestAgentSessionStore(fixture.rig.root, (state) => {
    state.records[sessionId] = {
      ...state.records[SESSION],
      sessionId,
      lease: {
        ...state.records[SESSION].lease,
        sessionId,
        runtimeFence: envelope.expectedRuntimeFence
      },
      providerHandleChain: state.records[SESSION].providerHandleChain.map((link) => ({
        ...link,
        mintedAtFence: envelope.expectedRuntimeFence
      })),
      options: { model: 'historical-acp-M' }
    }
    state.operations[agentSessionOperationKey(row.callerKey, row.operationId)] = row
  })
  await fixture.rig.restart()
  setStructuredAgentSessionHost(fixture.rig.host)
  const params = { key: 'model', value: '', envelope }
  expect((await call('agentSession.setOption', params))[0]).toMatchObject({
    result: { ok: true, replayed: true, value: { options: { model: 'historical-acp-M' } } }
  })
  await call('agentSession.setOption', optionRequest('later-model', sessionId))
  expect((await call('agentSession.setOption', params))[0]).toMatchObject({
    result: { ok: true, replayed: true, value: { options: { model: 'later-model' } } }
  })
  expect(fixture.rig.store.getOperationRow(row.callerKey, row.operationId)?.outcome).toEqual(
    row.outcome
  )
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  expect(fixture.rig.adapter.readOptions).not.toHaveBeenCalled()
})

it('keeps unreadable accepted results spent and modern empty writes on their ordinary path', async () => {
  await restingChat()
  const params = optionRequest('')
  await call('agentSession.setOption', params)
  for (const optionResult of [null, { version: 2, key: 'model', value: '', options: {} }]) {
    await editPersistedTestAgentSessionStore(fixture.rig.root, (state) => {
      const row = Object.values(state.operations).find(
        (row) => row.operationId === params.envelope.clientOperationId
      )!
      row.outcome = { status: 'succeeded', sessionId: SESSION, optionResult }
    })
    await fixture.rig.restart()
    setStructuredAgentSessionHost(fixture.rig.host)
    expect((await call('agentSession.setOption', params))[0]).toMatchObject({
      result: { ok: false, refusal: { details: { reason: 'resultLost' } } }
    })
    expect(
      fixture.rig.store.getOperationRow('device-1', params.envelope.clientOperationId)?.outcome
    ).toMatchObject({ optionResult })
  }
  const modern = {
    ...CLIENT,
    clientCapabilities: [
      ...CLIENT.clientCapabilities,
      AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
    ]
  }
  expect((await call('agentSession.setOption', optionRequest(''), modern))[0]).toMatchObject({
    ok: false
  })
  expect(fixture.rig.store.getRecord(SESSION)?.options).toEqual({
    model: 'gpt-saved',
    effort: 'high'
  })
})

it('reads, subscribes and answers everything without starting an agent', async () => {
  await restingChat()
  expect(fixture.rig.host.hasSession(SESSION)).toBe(false)

  const [history] = await call('agentSession.history', { sessionId: SESSION, direction: 'tail' })
  const frames = await call('agentSession.subscribe', { sessionId: SESSION })
  const [options] = await call('agentSession.options', { sessionId: SESSION })
  const [commands] = await call('agentSession.commands', { sessionId: SESSION })
  const [outline] = await call('agentSession.conversationOutline', { sessionId: SESSION })
  const [status] = await call('agentSession.handoffStatus', { sessionId: SESSION })
  const [held] = await call('agentSession.hold', { sessionId: SESSION, holderId: 'pane' })

  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  expect(history).toMatchObject({ ok: true, result: { ok: true } })
  // The opening snapshot follows subscribe's reply on the still-open stream.
  await vi.waitFor(() =>
    expect(frames.find((frame) => frame.ok && 'result' in frame)).toMatchObject({
      result: { type: 'snapshot', commands: null }
    })
  )
  expect(options).toMatchObject({
    ok: true,
    result: { current: { model: 'gpt-saved', effort: 'high' } }
  })
  // Absent, never an empty list: the composer keeps its own menu.
  expect(commands).toMatchObject({ ok: true, result: {} })
  expect(commands?.ok && 'result' in commands && commands.result).not.toHaveProperty('commands', [])
  expect(outline).toMatchObject({ ok: true })
  expect(status).toMatchObject({ ok: true })
  expect(held).toMatchObject({ ok: true, result: { held: true } })
})

it('opens nothing once quit began, for a read that was already waiting on the lock', async () => {
  await restingChat()
  // The host's per-session queue, held so the read waits behind it.
  const { serialize, lifetime } = fixture.rig.host.collaboratorsForTests()
  let release = (): void => undefined
  const held = new Promise<void>((started) => {
    void serialize(SESSION, () => {
      started()
      return new Promise<void>((resolve) => (release = resolve))
    })
  })
  await held
  const read = fixture.rig.host.history({ sessionId: SESSION, direction: 'tail' })

  // Disposed as quit's first teardown step does.
  lifetime.dispose()
  release()

  await expect(read).rejects.toThrow()
  expect(fixture.rig.host.hasSession(SESSION)).toBe(false)
})

it('refuses a read whose journal will not open with the classified reason, never the storage text', async () => {
  await restingChat()
  const open = vi.spyOn(fixture.rig.host.collaboratorsForTests().conversationDelivery, 'open')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const storagePath = '/Users/someone/.orca/journals/session-1/journal.sqlite'
  const failWith = (error: Error): void => {
    open.mockRejectedValue(error)
  }
  const failures = async (): Promise<RpcResponse[]> =>
    [
      ...(await call('agentSession.history', { sessionId: SESSION, direction: 'tail' })),
      ...(await call('agentSession.subscribe', { sessionId: SESSION })),
      ...(await call('agentSession.options', { sessionId: SESSION }))
    ].filter((reply) => !reply.ok)

  failWith(
    Object.assign(new Error(`file is not a database: ${storagePath}`), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 26
    })
  )
  const corrupt = await failures()
  failWith(Object.assign(new Error(`EACCES: permission denied, open '${storagePath}'`), {}))
  const unavailable = await failures()

  for (const [replies, reason] of [
    [corrupt, 'journalCorrupt'],
    [unavailable, 'journalUnavailable']
  ] as const) {
    expect(replies).toHaveLength(3)
    for (const reply of replies) {
      expect(reply).toMatchObject({
        ok: false,
        error: {
          // Released clients still read this refusal code from the message, not passthrough code.
          code: 'runtime_error',
          message: 'agent_session_journal_unreadable',
          data: { refusal: { code: 'agent_session_journal_unreadable', details: { reason } } }
        }
      })
      expect(JSON.stringify(reply)).not.toContain(storagePath)
    }
  }
})

it('logs a reader reconnecting to a journal that will not open once per failure', async () => {
  await restingChat()
  const open = vi.spyOn(fixture.rig.host.collaboratorsForTests().conversationDelivery, 'open')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const logged = (): unknown[] =>
    warn.mock.calls
      .filter(
        ([line]) =>
          line === '[agent-session] open-for-read: opening the conversation for a read failed'
      )
      .map(([, fields]) => fields?.error)
  const reconnect = async (): Promise<RpcResponse[]> => [
    ...(await call('agentSession.subscribe', { sessionId: SESSION })),
    ...(await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }))
  ]
  const denied = new Error('EACCES: permission denied')
  const exhausted = new Error('EMFILE: too many open files')

  open.mockRejectedValue(denied)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // Every attempt is still refused with its reason; only the log is quiet.
    expect((await reconnect()).filter((reply) => !reply.ok)).toHaveLength(2)
  }
  expect(logged()).toEqual([denied])
  open.mockRejectedValue(exhausted)
  await reconnect()
  await reconnect()
  expect(logged()).toEqual([denied, exhausted])
})

it('resets catch-up over an unreadable event while keeping the current conversation readable', async () => {
  await restingChat()
  await call('agentSession.subscribe', { sessionId: SESSION })
  const live = await journalSqlReads(
    fixture.rig.host.deps.journalDatabase.readers,
    SESSION
  ).cursor()
  await withTestAgentSessionDatabase(fixture.rig.root, (db) => {
    db.prepare(
      'UPDATE journal_events SET changes_json=? WHERE session_id=? AND sequence=(SELECT MIN(sequence) FROM journal_events WHERE session_id=? AND sequence>1)'
    ).run('{damaged', SESSION, SESSION)
  })
  const stale = { epoch: live.epoch, sequence: 1 }
  expect(
    (
      await call('agentSession.history', { sessionId: SESSION, direction: 'after', cursor: stale })
    )[0]
  ).toMatchObject({
    ok: true,
    result: {
      ok: false,
      reset: 'schema_unreadable',
      page: { items: [{ body: { kind: 'message' } }] }
    }
  })
  const reset = await call('agentSession.subscribe', { sessionId: SESSION, cursor: stale })
  await vi.waitFor(() =>
    expect(reset[0]).toMatchObject({
      ok: true,
      result: { type: 'reset', reset: 'schema_unreadable' }
    })
  )
  const caughtUp = await call('agentSession.subscribe', { sessionId: SESSION, cursor: live })
  await vi.waitFor(() => expect(caughtUp[0]).toMatchObject({ ok: true, result: { type: 'batch' } }))
})

it('keeps a storage failure during catch-up retryable instead of resetting the client', async () => {
  await restingChat()
  const live = await journalSqlReads(
    fixture.rig.host.deps.journalDatabase.readers,
    SESSION
  ).cursor()
  const catchUp = {
    sessionId: SESSION,
    direction: 'after',
    cursor: { epoch: live.epoch, sequence: 1 }
  }
  await withTestAgentSessionDatabase(fixture.rig.root, (db) =>
    db.exec('ALTER TABLE journal_events RENAME TO journal_events_unavailable')
  )
  try {
    expect((await call('agentSession.history', catchUp))[0]).toMatchObject({
      ok: false,
      error: { code: 'runtime_error' }
    })
  } finally {
    await withTestAgentSessionDatabase(fixture.rig.root, (db) =>
      db.exec('ALTER TABLE journal_events_unavailable RENAME TO journal_events')
    )
  }
  expect((await call('agentSession.history', catchUp))[0]).toMatchObject({
    ok: true,
    result: { ok: true }
  })
})

it('replays SQL revisions and removals after a converted chat reopens without duplicate messages', async () => {
  const { rig } = fixture
  seedQueuedRigLegacyJournal(rig.root, SESSION)
  const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
  if (!attached.ok) {
    throw new Error('fixture attach refused')
  }
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const options = { fence: attached.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const prompt = { provider: 'orca', clientMessageId: 'saved-prompt' } as const
  const answer = { provider: 'orca', clientMessageId: 'saved-answer' } as const
  const disposable = { provider: 'orca', clientMessageId: 'removed-status' } as const
  await journal.appendItem(
    prompt,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Saved question' }] },
    options
  )
  await journal.appendItem(
    answer,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Before revision' }] },
    options
  )
  const removed = await journal.appendItem(
    disposable,
    { kind: 'status', text: 'Remove after close' },
    options
  )
  const before = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  const cursor = before.page.liveCursor!
  await rig.host.close(SESSION, 'evict')
  const stored = await AgentSessionJournal.open({
    database: rig.host.deps.journalDatabase,
    identity: journal.identity,
    now: () => rig.clock.now
  })
  try {
    await stored.appendItem(
      answer,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'After revision' }] },
      options
    )
    await stored.appendTombstone(disposable, { fence: attached.fence })
  } finally {
    await stored.close()
  }
  const reopened = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  const events: AgentSessionSubscribeEvent[] = []
  await rig.host.subscribe({
    id: 'restored-sql-reader',
    sessionId: SESSION,
    cursor,
    snapshotCatchUp: false,
    emit: (event) => events.push(event)
  })
  await vi.waitFor(() =>
    expect(
      events.some(
        (event) =>
          event.type === 'batch' &&
          event.batch.cursor.sequence === reopened.page.liveCursor?.sequence
      )
    ).toBe(true)
  )
  const restored = events.reduce(
    (state, event) => reduceStructuredAgentSession(state, { type: 'event', event }, 1000),
    reduceStructuredAgentSession(
      EMPTY_STRUCTURED_AGENT_SESSION,
      { type: 'history-page', page: before.page },
      1000
    )
  )
  expect(
    restored.items.filter((item) => item.body.kind === 'message').map((item) => item.body)
  ).toEqual([
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Saved question' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'After revision' }] }
  ])
  expect(restored.items.some((item) => item.itemId === removed.itemId)).toBe(false)
})
