import { expect, it } from 'vitest'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { ClaudeControlRequestError } from '../../claude/claude-agent-sdk-control-requests'
import { CLAUDE_STOP_GRACE_MS } from '../../claude/claude-request-end-wait'
import {
  claudeFrame as frame,
  claudeWasSent as wrote,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

import {
  fixture,
  INTERRUPTED_RESULT,
  NEVER_ANSWERS,
  laneDrained
} from './structured-agent-session-claude-stop-contract-test-fixture'
import {
  agentStatus,
  childRecords,
  dispatch,
  eventually,
  interruptSent,
  openTurn,
  send,
  sendUnechoed,
  statusTexts,
  stop,
  stopEventsAtClose,
  turnOutcome,
  stopAcrossGrace
} from './structured-agent-session-claude-stop-contract-test-actions'

it('answers on the interrupt, ends the child once the stopped turn ends, and rests at that turn', async () => {
  const connection = fixture.claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  expect(connection.closed).toBe(false)
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  const ended = Date.now()
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  expect(Date.now() - ended).toBeLessThan(CLAUDE_STOP_GRACE_MS / 2)

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(fixture.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  expect(await turnOutcome()).toBe('cancellation')
  // Resume must use the stopped turn’s own leaf.
  expect(fixture.events.findLast((event) => event.type === 'handle')).toMatchObject({
    type: 'handle',
    providerSessionId: PROVIDER_SESSION_ID,
    leafUuid: 'stopped-turn-leaf'
  })
})

it('reads a Stop pressed before Claude echoed the send as interrupted, not as a finished turn', async () => {
  const connection = fixture.claude.connections[0]!
  // Match CLI wind-down ordering after an interrupt before echo.
  fixture.claude.routes.interrupt = () => {
    setTimeout(() => {
      const written = connection.sent.find((message) => message.type === 'user')!
      frame(connection, { ...written, uuid: written.uuid })
      frame(connection, {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }]
        },
        parent_tool_use_id: null,
        uuid: 'interrupted-marker'
      })
      frame(connection, INTERRUPTED_RESULT)
      frame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }, 5)
    return { still_queued: [], cancelled: [] }
  }
  const clientMessageId = await sendUnechoed(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(await dispatch(clientMessageId)).toMatchObject({ state: 'accepted' })
  expect(await turnOutcome()).toBe('cancellation')
  expect(await agentStatus()).toMatchObject({ mainAgent: { outcome: 'cancellation' } })
})

it('ends the child once the grace runs out when Claude says nothing after a Stop before the echo', async () => {
  const connection = fixture.claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  fixture.claude.routes.interrupt = () => ({ still_queued: [], cancelled: [] })
  const clientMessageId = await sendUnechoed(connection)

  await expect(stopAcrossGrace(connection, 'request-end')).resolves.toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await dispatch(clientMessageId)).toMatchObject({ state: 'unknown' })
}, 15_000)

it('withdraws a follow-up Claude queued behind the turn before the child ends, never doubt', async () => {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection)
  const followUp = await send('And then this.')
  await eventually(() => expect(connection.sent.at(-1)?.message).toBeDefined())
  fixture.queued.push(String(connection.sent.at(-1)!.uuid))
  await eventually(async () => expect((await dispatch(followUp)).state).toBe('pending'))

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })

  expect(connection.closed).toBe(false)
  expect(await dispatch(followUp)).toEqual({
    state: 'rejected',
    reason: DISPATCH_REJECTED_CANCELLED
  })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  expect(connection.closed).toBe(true)
})

it('ends the child at once when Claude refuses the interrupt, and says only that the stop was asked', async () => {
  fixture.claude.routes.interrupt = () => {
    throw new ClaudeControlRequestError('interrupt', 'Claude did not answer the interrupt.')
  }
  const connection = fixture.claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  await openTurn(connection)

  const asked = Date.now()
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()
  // Failed interrupts terminate immediately instead of consuming grace.
  expect(Date.now() - asked).toBeLessThan(CLAUDE_STOP_GRACE_MS / 2)

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await turnOutcome()).toBe('cancellation')
  const texts = await statusTexts()
  expect(texts).toContain('Cancellation requested.')
  expect(texts.some((text) => text.includes("didn't stop"))).toBe(false)
})

it('ends the child when the interrupt fails, with no unconfirmed row', async () => {
  fixture.claude.routes.interrupt = () => {
    throw new Error('control request lost')
  }
  const connection = fixture.claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await turnOutcome()).toBe('cancellation')
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
})

it('ends the child within the grace when Claude never answers the interrupt', async () => {
  fixture.claude.routes.interrupt = NEVER_ANSWERS
  const connection = fixture.claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  await openTurn(connection)

  await expect(stopAcrossGrace(connection, 'interrupt')).resolves.toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await turnOutcome()).toBe('cancellation')
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
}, 15_000)

it('ends background work Claude runs when the Stop ends the child', async () => {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection)
  frame(connection, {
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-start',
    task_id: 'background-1',
    task_type: 'local_agent',
    is_backgrounded: true
  })
  const background = { providerId: 'background-1', kind: 'agent' }
  expect(childRecords()).toEqual([
    expect.objectContaining({ ...background, state: 'working', membership: 'live' })
  ])

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  expect(childRecords()).toEqual([
    expect.objectContaining({
      ...background,
      state: 'done',
      membership: 'settled',
      // Process termination proves contact loss, not provider acceptance of task Stop.
      outcome: 'unknown'
    })
  ])
  expect(await agentStatus()).toEqual({
    state: 'done',
    mainAgent: { state: 'done', outcome: 'cancellation' }
  })
  expect(connection.closed).toBe(true)
})

it('starts a new child for the next send after a Stop, on the same Claude conversation', async () => {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection)
  await stop()
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  const next = await send('Carry on.')
  const resumed = await eventually(() => {
    const started = fixture.claude.connections.at(-1)
    expect(started).not.toBe(connection)
    expect(started && wrote(started, 'Carry on.')).toBe(true)
    return started!
  })
  expect(fixture.store.getRecord(SESSION)?.providerHandleChain.at(-1)?.handle).toMatchObject({
    nativeId: PROVIDER_SESSION_ID
  })
  expect(resumed.closed).toBe(false)
  expect(await dispatch(next)).toMatchObject({ state: 'pending' })
})

it('delivers a send issued with the pre-Stop fence during the Stop to the resumed child only', async () => {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection)
  const fence = fixture.store.getRecord(SESSION)!.lease.runtimeFence
  let childrenWhenClosed: number | undefined
  const close = connection.close
  connection.close = async () => {
    const proven = await close()
    childrenWhenClosed = fixture.claude.connections.length
    return proven
  }

  let answer!: () => void
  fixture.claude.routes.interrupt = () =>
    new Promise((resolve) => {
      answer = () => resolve({ still_queued: [], cancelled: [] })
    })

  // Issue under the old fence while Stop’s first step awaits its interrupt.
  const stopped = stop()
  await interruptSent(connection)
  const sent = send('Typed during the Stop.', fence)
  answer()
  expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)

  await expect(sent).resolves.toEqual(expect.any(String))
  const resumed = await eventually(() => {
    const started = fixture.claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, 'Typed during the Stop.')).toBe(true)
    return started
  })
  expect(childrenWhenClosed).toBe(1)
  expect(resumed.closed).toBe(false)
  expect(wrote(connection, 'Typed during the Stop.')).toBe(false)
  expect(fixture.store.getRecord(SESSION)!.lease.runtimeFence).not.toBe(fence)
  expect((await statusTexts()).filter((text) => text !== 'Cancellation requested.')).toEqual([])
})
