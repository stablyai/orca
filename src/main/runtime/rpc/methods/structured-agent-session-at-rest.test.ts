import '../unused-default-rpc-methods.test-fixture'
vi.mock('node:fs/promises', { spy: true })
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session-journal-types'
import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../../shared/agent-session-optional-model-capability'
import { agentSessionOperationKey } from '../../../../shared/agent-session-operation-ledger'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks
} from '../../../../shared/structured-agent-session-options'
import {
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD,
  restTestSend
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { editPersistedTestAgentSessionStore } from '../../agent-session-record-store-test-harness'
import type { RpcResponse } from '../core'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'

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
  const replace = vi.spyOn(fixture.rig.store, 'replaceSessionOptions')
  fixture.rig.sink.publish.mockClear()
  const params = optionRequest('')
  const inert = { key: 'model', value: '', options: {} }
  expect((await call('agentSession.setOption', params))[0]).toMatchObject({
    result: { ok: true, replayed: false, value: inert }
  })
  expect(replace).not.toHaveBeenCalled()
  expect(fixture.rig.sink.publish).not.toHaveBeenCalled()
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
  const snapshot = frames.find((frame) => frame.ok && 'result' in frame)
  expect(snapshot).toMatchObject({ result: { type: 'snapshot', commands: null } })
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

it('answers the owner check from the record without opening the chat', async () => {
  await restingChat()

  const [status] = await call('agentSession.handoffStatus', { sessionId: SESSION })

  expect(status).toMatchObject({ ok: true, result: { owner: expect.any(String) } })
  expect(fixture.rig.host.hasSession(SESSION)).toBe(false)
})

it('starts the agent on the first send (P2-01)', async () => {
  await restingChat()
  const fence = fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence
  const sent = await fixture.rig.host.send(CALLER, restTestSend('wake up', fence))
  if (!sent.ok) {
    throw new Error(`send refused: ${sent.refusal.code}`)
  }
  // Awaits the provider's answer itself rather than polling for it, however slow the start.
  await fixture.rig.host.waitForSendSettlement(SESSION, sent.value.clientMessageId)
  expect(fixture.rig.adapter.acquire).toHaveBeenCalledOnce()
  expect(fixture.rig.adapter.dispatch).toHaveBeenCalledOnce()
})

it('opens a closed conversation once, however many readers arrive together (P2-02)', async () => {
  const attached = await fixture.rig.host.attach(CALLER, hostTestAttachParams(null))
  expect(attached.ok).toBe(true)
  fixture.rig.adapter.acquire.mock.calls
    .at(-1)?.[0]
    .events?.appendItem(
      { provider: 'codex', threadId: REST_TEST_THREAD, turnId: 'turn-1', ordinal: 1 },
      hostTestMessage('from the provider'),
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await fixture.rig.host.flushStreamedEvents(SESSION)
  await fixture.rig.restart()
  setStructuredAgentSessionHost(fixture.rig.host)
  fixture.rig.adapter.acquire.mockClear()
  const open = vi.spyOn(fixture.rig.host.collaboratorsForTests().conversationDelivery, 'open')
  await Promise.all([
    ...Array.from({ length: 5 }, () =>
      call('agentSession.history', { sessionId: SESSION, direction: 'tail' })
    ),
    call('agentSession.subscribe', { sessionId: SESSION })
  ])
  const openedJournals = new Set(await Promise.all(open.mock.results.map((result) => result.value)))
  expect(openedJournals.size).toBe(1)
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
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

it('refuses a read it cannot open with the reason, under the same code and message', async () => {
  const [missing] = await call('agentSession.history', {
    sessionId: 'session-never-created',
    direction: 'tail'
  })
  expect(missing).toMatchObject({
    ok: false,
    error: {
      code: 'agent_session_identity_required',
      message: 'agent_session_identity_required',
      data: {
        refusal: {
          code: 'agent_session_identity_required',
          details: { reason: 'recordMissing' }
        }
      }
    }
  })
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

it('refuses a damaged journal as unloadable at subscribe and send, and keeps its rows (P2-03)', async () => {
  await foundRestTestChat(fixture.rig)
  await fixture.rig.host.flushAllStreamedEvents()
  openTestJournalHostDatabase(fixture.rig.root)
    .db.prepare(
      "UPDATE journal_outcomes SET value_json = '}{' WHERE generation = (SELECT generation FROM journal_outcome_epochs WHERE session_id = ?) AND seq = 2"
    )
    .run(SESSION)
  await fixture.rig.restart()
  setStructuredAgentSessionHost(fixture.rig.host)

  const frames = await call('agentSession.subscribe', { sessionId: SESSION })
  expect(frames.find((frame) => !frame.ok)).toMatchObject({
    error: {
      data: {
        refusal: {
          code: 'agent_session_journal_unreadable',
          details: { reason: 'journalCorrupt' }
        }
      }
    }
  })
  const fence = fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence
  expect(
    await fixture.rig.host.send(CALLER, restTestSend('after the damage', fence))
  ).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
  })
  expect(
    openTestJournalHostDatabase(fixture.rig.root)
      .db.prepare(
        'SELECT value_json FROM journal_outcomes WHERE generation = (SELECT generation FROM journal_outcome_epochs WHERE session_id = ?) AND seq = 2 LIMIT 1'
      )
      .get(SESSION)?.value_json
  ).toBe('}{')
})
