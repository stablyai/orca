import { expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  CALLER,
  attach,
  envelope,
  hostTestState
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

it('rechecks a goal retry settled during startup, and replays it later without a child', async () => {
  const { host, store, acquire } = hostTestState()
  const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
  host.deps.adapter.changeThreadGoal = changeThreadGoal
  await attach()
  const change = { kind: 'set' as const, objective: 'Ship the parser' }
  let params = { envelope: envelope('agentSession.threadGoal', { change }), change }
  changeThreadGoal.mockRejectedValueOnce(new Error('not applied'))
  await expect(host.changeThreadGoal(CALLER, params)).rejects.toThrow('not applied')
  expect(await host.changeThreadGoal(CALLER, params)).toMatchObject({ ok: true, replayed: false })
  params = { envelope: envelope('agentSession.threadGoal', { change }), change }
  changeThreadGoal.mockRejectedValueOnce(new Error('not applied'))
  await expect(host.changeThreadGoal(CALLER, params)).rejects.toThrow('not applied')
  await host.close(SESSION, 'evict')
  let ready!: () => void
  const open = vi.fn(
    () =>
      new Promise<{ reportedOptions: { model: string } }>((resolve) => {
        ready = () => resolve({ reportedOptions: { model: 'default' } })
      })
  )
  host.deps.adapter.open = open
  const retry = host.changeThreadGoal(CALLER, params)
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
  expect(changeThreadGoal).toHaveBeenCalledTimes(3)
  await store.recordOperationOutcome({
    callerKey: CALLER.callerKey,
    operationId: params.envelope.clientOperationId,
    outcome: { status: 'succeeded', sessionId: SESSION }
  })
  ready()
  expect(await retry).toMatchObject({ ok: true, replayed: true })
  expect(changeThreadGoal).toHaveBeenCalledTimes(3)
  expect(acquire).toHaveBeenCalledTimes(2)
  await host.close(SESSION, 'evict')
  expect(await host.changeThreadGoal(CALLER, params)).toMatchObject({ ok: true, replayed: true })
  expect(acquire).toHaveBeenCalledTimes(2)
  expect(changeThreadGoal).toHaveBeenCalledTimes(3)
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
    const goal = host.changeThreadGoal(CALLER, {
      envelope: envelope('agentSession.threadGoal', { change: next }),
      change: next
    })
    const result = goal.catch((error: unknown) => error)
    await (phase === 'append'
      ? vi.waitFor(() => expect(append).toHaveBeenCalledOnce())
      : host.collaboratorsForTests().serialize(SESSION, async () => {}))
    const stopped = host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
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
      expect(append.mock.calls.some(([, body]) => body.kind === 'status')).toBe(false)
    }
  }
)
