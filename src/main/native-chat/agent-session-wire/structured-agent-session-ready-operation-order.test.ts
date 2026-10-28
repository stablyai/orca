import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { abandonStructuredAgentSessionHost } from './structured-agent-session-host-test-abandon'
import { expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import {
  CALLER,
  attach,
  envelope,
  hostTestState,
  hostTestRecoveryCapsuleSettled,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

it.each(['send', 'compact'] as const)(
  'answers an accepted %s receipt during an unconfirmed rewind without starting an agent',
  async (command) => {
    const { host, store, acquire, dispatch } = hostTestState()
    const compact = vi.fn(async () => ({ state: 'admitted' as const }))
    host.deps.adapter.compact = compact
    const providerWrites = command === 'send' ? dispatch : compact
    await attach()
    const body = hostTestMessage('already accepted')
    const params = {
      envelope: envelope(
        command === 'send' ? 'agentSession.send' : 'agentSession.conversationCommand',
        command === 'send' ? { body } : { command: 'compact' }
      ),
      body,
      command: 'compact' as const
    }
    const run = (caller = CALLER) =>
      command === 'send' ? host.send(caller, params) : host.conversationCommand(caller, params)
    expect(await run()).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(providerWrites).toHaveBeenCalledTimes(1))
    await host.close(SESSION, 'evict')
    const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      rewind: {
        operationId: envelope('agentSession.rewind', {}).clientOperationId,
        callerKey: CALLER.callerKey,
        itemId: agentJournalSubmissionKey(params.envelope.clientOperationId),
        providerItemId: 'codex:thread-1:turn-1:1',
        expectedEpoch,
        phase: 'prepared',
        retained: []
      }
    }))
    acquire.mockRejectedValueOnce(new Error('restart failed'))

    expect(await run({ callerKey: 'reconnecting-phone' })).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(providerWrites).toHaveBeenCalledTimes(1)
  }
)

it('persists unknown Set objective and receipt across reopen, without replay overriding later actions', async () => {
  const { root, acquire } = hostTestState()
  let { host, store } = hostTestState()
  const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
  host.deps.adapter.changeThreadGoal = changeThreadGoal
  await attach()
  const change = { kind: 'set' as const, objective: 'Ship the parser' }
  const params = { envelope: envelope('agentSession.threadGoal', { change }), change }
  changeThreadGoal.mockRejectedValueOnce(new Error('reply lost'))
  await expect(host.changeThreadGoal(CALLER, params)).rejects.toThrow('reply lost')
  expect(
    store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)?.outcome
  ).toEqual({ status: 'unknown' })
  const attempted = {
    kind: 'message',
    role: 'user',
    sentAs: 'goal',
    blocks: [{ type: 'text', text: change.objective }]
  }
  const originalJournal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await host.close(SESSION, 'evict')
  await abandonStructuredAgentSessionHost(host)
  await hostTestRecoveryCapsuleSettled()
  const database = host.deps.journalDatabase
  closeTestJournalHostDatabase(root)
  expect(database.isClosed).toBe(true)
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    ...host.deps,
    store,
    journalDatabase: openTestJournalHostDatabase(root)
  })
  replaceHostTestState({ host, store })
  expect((await host.journalSnapshot(SESSION)).items.map((item) => item.body)).toContainEqual(
    attempted
  )
  expect(host.collaboratorsForTests().sessions.get(SESSION)!.journal).not.toBe(originalJournal)
  expect(
    store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)?.outcome
  ).toEqual({ status: 'unknown' })
  expect(await host.changeThreadGoal(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(changeThreadGoal).toHaveBeenCalledOnce()
  const latestGoal = {
    objective: 'Ship the newer goal',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 2
  } as const
  const laterActions = [
    { kind: 'status', status: 'paused' },
    { kind: 'clear' },
    { kind: 'set', objective: latestGoal.objective }
  ] as const
  const acceptedActions = laterActions.map((later) => ({
    envelope: envelope('agentSession.threadGoal', { change: later }),
    change: later
  }))
  for (const accepted of acceptedActions) {
    expect(await host.changeThreadGoal(CALLER, accepted)).toMatchObject({ ok: true })
    if (accepted.change.kind === 'set') {
      acquire.mock.calls
        .at(-1)![0]
        .events!.appendItem(
          { provider: 'orca', clientMessageId: 'reported-newer-goal' },
          { kind: 'status', text: 'Goal', threadGoal: { state: 'set', goal: latestGoal } },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      await host.flushStreamedEvents(SESSION)
    }
    const beforeReplay = await host.journalSnapshot(SESSION)
    expect(await host.changeThreadGoal(CALLER, params)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(await host.journalSnapshot(SESSION)).toEqual(beforeReplay)
  }
  expect(host.collaboratorsForTests().sessions.get(SESSION)!.journal.threadGoal()).toEqual(
    latestGoal
  )
  expect(changeThreadGoal).toHaveBeenCalledTimes(4)
  await host.close(SESSION, 'evict')
  expect(await host.changeThreadGoal(CALLER, acceptedActions[1]!)).toMatchObject({
    ok: true,
    replayed: true
  })
  expect(await host.changeThreadGoal(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(acquire).toHaveBeenCalledTimes(2)
  expect(changeThreadGoal).toHaveBeenCalledTimes(4)
  expect(host.collaboratorsForTests().sessions.get(SESSION)!.journal.threadGoal()).toEqual(
    latestGoal
  )
})

it.each([false, true])('keeps a goal behind active dispatch (ready child: %s)', async (ready) => {
  const { host, dispatch } = hostTestState()
  const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
  host.deps.adapter.changeThreadGoal = changeThreadGoal
  await attach()
  if (ready) {
    const change = { kind: 'set' as const, objective: 'Warm child' }
    await host.changeThreadGoal(CALLER, {
      envelope: envelope('agentSession.threadGoal', { change }),
      change
    })
    changeThreadGoal.mockClear()
  }
  const held = Promise.withResolvers<{ state: 'admitted' }>()
  dispatch.mockImplementationOnce(() => held.promise)
  const body = hostTestMessage('Earlier message')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  const change = { kind: 'set' as const, objective: 'Later goal' }
  const goal = host.changeThreadGoal(CALLER, {
    envelope: envelope('agentSession.threadGoal', { change }),
    change
  })
  await host.collaboratorsForTests().serialize(SESSION, async () => {})
  expect(changeThreadGoal).not.toHaveBeenCalled()
  held.resolve({ state: 'admitted' })
  expect(await goal).toMatchObject({ ok: true })
  expect(changeThreadGoal).toHaveBeenCalledOnce()
})

it.each(['append', 'wait'] as const)(
  'Stop revokes a goal during %s through settlement',
  async (phase) => {
    const { host, dispatch } = hostTestState()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    host.deps.adapter.changeThreadGoal = changeThreadGoal
    await attach()
    const change = { kind: 'set' as const, objective: 'Warm child' }
    await host.changeThreadGoal(CALLER, {
      envelope: envelope('agentSession.threadGoal', { change }),
      change
    })
    changeThreadGoal.mockClear()
    const held = Promise.withResolvers<void>()
    if (phase === 'wait') {
      dispatch.mockImplementationOnce(async () => {
        await held.promise
        return { state: 'admitted' }
      })
      const body = hostTestMessage('Earlier message')
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    }
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const append = vi.spyOn(journal, 'appendItem')
    const withdraw = vi.spyOn(journal, 'appendTombstone')
    if (phase === 'append') {
      const original = journal.appendItem.bind(journal)
      append.mockImplementationOnce(async (...args) => {
        await held.promise
        return original(...args)
      })
    }
    const next = { ...change, objective: 'Later goal' }
    const goalEnvelope = envelope('agentSession.threadGoal', { change: next })
    const goal = host.changeThreadGoal(CALLER, {
      envelope: goalEnvelope,
      change: next
    })
    const result = goal.catch((error: unknown) => error)
    await (phase === 'append'
      ? vi.waitFor(() => expect(append).toHaveBeenCalledOnce())
      : host.collaboratorsForTests().serialize(SESSION, async () => {}))
    const stopEnvelope = envelope('agentSession.cancel', {})
    const stopped = host.cancel(CALLER, { envelope: stopEnvelope })
    expect(changeThreadGoal).not.toHaveBeenCalled()
    held.resolve()
    if (phase === 'append') {
      expect(await result).toBeInstanceOf(Error)
      expect(withdraw).toHaveBeenCalledOnce()
    } else {
      expect(await result).toMatchObject({ ok: false })
    }
    expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(changeThreadGoal).not.toHaveBeenCalled()
    if (phase === 'append') {
      expect(withdraw).toHaveBeenCalledWith(
        { provider: 'orca', clientMessageId: `thread-goal:${goalEnvelope.clientOperationId}` },
        expect.anything()
      )
      expect(append.mock.calls.filter(([, body]) => body.kind === 'status')).toEqual([
        [
          structuredAgentSessionStopNoteIdentity(stopEnvelope.clientOperationId),
          { kind: 'status', text: 'Cancellation requested.' },
          expect.anything()
        ]
      ])
    }
  }
)
