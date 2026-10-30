import { expect, it } from 'vitest'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import {
  claudeFrame as frame,
  claudeWasSent as wrote
} from '../../claude/claude-structured-session-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

import {
  fixture,
  BRANCH_QUESTION,
  CALLER,
  INTERRUPTED_RESULT,
  laneDrained
} from './structured-agent-session-claude-stop-contract-test-fixture'
import {
  ask,
  cancelCard,
  cardResolution,
  envelope,
  eventually,
  interruptSent,
  openTurn,
  send,
  statusTexts,
  stop,
  stopEventsAtClose,
  turnOutcome
} from './structured-agent-session-claude-stop-contract-test-actions'

it('sends a queue-if-active message issued while the Stop ends the child directly to the resumed child', async () => {
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

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  // Issue under the old fence while Stop’s second step awaits turn end.
  const body = hostTestMessage('Queued during the Stop.')
  const sent = fixture.host.send(CALLER, {
    envelope: envelope('agentSession.send', { body, delivery: 'queue-if-active' }, fence),
    body,
    delivery: 'queue-if-active'
  })
  frame(connection, INTERRUPTED_RESULT)

  expect(await sent).toMatchObject({ ok: true, value: { submission: expect.any(Object) } })
  await eventually(() => {
    const started = fixture.claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, 'Queued during the Stop.')).toBe(true)
  })
  expect(childrenWhenClosed).toBe(1)
  expect(wrote(connection, 'Queued during the Stop.')).toBe(false)
})

it("runs nothing queued during the Stop's first step before the child's end", async () => {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection)
  let answer!: () => void
  fixture.claude.routes.interrupt = () =>
    new Promise((resolve) => {
      answer = () => resolve({ still_queued: [], cancelled: [] })
    })

  const stopped = stop()
  await interruptSent(connection)
  let childLiveForNextOperation: boolean | undefined
  const next = fixture.host['tasks'].serialize(SESSION, async () => {
    childLiveForNextOperation = !connection.closed
  })
  answer()
  await stopped
  frame(connection, INTERRUPTED_RESULT)
  await next

  expect(childLiveForNextOperation).toBe(false)
})

it('still answers the Stop, with its row, when the child cannot be proven gone; the failure is reported', async () => {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection)
  const close = connection.close
  connection.close = async () => false

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  expect(fixture.logs.entries).toEqual([
    expect.objectContaining({
      fields: expect.objectContaining({
        scope: 'chat-stop',
        error: expect.objectContaining({
          name: 'StructuredAgentSessionEvictionError',
          step: 'stop-provider-child'
        })
      })
    })
  ])
  connection.close = close
})

it('leaves the child and the follow-up alone for a Stop naming the turn that just ended', async () => {
  const connection = fixture.claude.connections[0]!
  const ended = await openTurn(connection)
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1' })
  await eventually(async () =>
    expect(
      activeStructuredAgentSessionTurnId((await fixture.host.journalSnapshot(SESSION)).items)
    ).toBeNull()
  )
  await send('Follow-up.')
  await eventually(() => expect(wrote(connection, 'Follow-up.')).toBe(true))

  await expect(stop(ended)).resolves.toMatchObject({ ok: true, value: { cancelled: false } })
  await laneDrained()

  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(connection.closed).toBe(false)
  expect(await statusTexts()).toEqual([])
})

it('keeps a second Stop pressed while the first ends the child quiet', async () => {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  const second = stop()
  frame(connection, INTERRUPTED_RESULT)

  await expect(second).resolves.toMatchObject({ ok: true, value: { cancelled: false } })
  expect(connection.closed).toBe(true)
  expect(connection.calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(1)
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  expect(fixture.logs.entries).toEqual([])
})

it('dismisses an approval card on its Cancel with the Deny reply, and the turn and child go on', async () => {
  const connection = fixture.claude.connections[0]!
  const turnId = await openTurn(connection)
  const { answered, card } = await ask(connection, 'Bash', { command: 'rm -rf build' })

  await expect(cancelCard(turnId, card)).resolves.toMatchObject({
    ok: true,
    value: { turnId, cancelled: true }
  })
  await laneDrained()

  const reply = await answered.promise
  expect(reply).toMatchObject({ behavior: 'deny', message: 'User denied this action.' })
  expect(reply).not.toHaveProperty('interrupt')
  expect(await cardResolution(card.itemId)).toMatchObject({
    state: 'cancelled',
    resolvedBy: CALLER.callerKey
  })
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(connection.closed).toBe(false)
  expect(
    activeStructuredAgentSessionTurnId((await fixture.host.journalSnapshot(SESSION)).items)
  ).toBe(turnId)
  expect(await statusTexts()).toEqual([])
})

it("ends a question card's Cancel the way the chat's Stop does, and the next send resumes", async () => {
  const connection = fixture.claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  const turnId = await openTurn(connection)
  const request = new AbortController()
  const { answered, card } = await ask(
    connection,
    'AskUserQuestion',
    BRANCH_QUESTION,
    request.signal
  )

  await expect(cancelCard(turnId, card)).resolves.toMatchObject({
    ok: true,
    value: { turnId, cancelled: true }
  })
  request.abort()
  await fixture.host.flushStreamedEvents(SESSION)
  // Prompt cancellation must land before child exit so answers are already disabled.
  expect(connection.closed).toBe(false)
  const cancelledHere = { state: 'cancelled', resolvedBy: CALLER.callerKey }
  expect(await cardResolution(card.itemId)).toMatchObject(cancelledHere)
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await turnOutcome()).toBe('cancellation')
  expect(await answered.promise).not.toMatchObject({ behavior: expect.any(String) })
  expect(await cardResolution(card.itemId)).toMatchObject(cancelledHere)
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  await send('Carry on.')
  await eventually(() => {
    const started = fixture.claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, 'Carry on.')).toBe(true)
  })
})

it("declines a question card's Cancel itself when the Stop finds nothing to stop", async () => {
  const connection = fixture.claude.connections[0]!
  const ended = await openTurn(connection)
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1' })
  await eventually(async () =>
    expect(
      activeStructuredAgentSessionTurnId((await fixture.host.journalSnapshot(SESSION)).items)
    ).toBeNull()
  )
  const { answered, card } = await ask(connection, 'AskUserQuestion', BRANCH_QUESTION)

  await expect(cancelCard(ended, card)).resolves.toMatchObject({ ok: true })
  await laneDrained()

  expect(await answered.promise).toMatchObject({
    behavior: 'deny',
    message: expect.stringMatching(/dismissed/)
  })
  expect(await cardResolution(card.itemId)).toMatchObject({
    state: 'cancelled',
    resolvedBy: CALLER.callerKey
  })
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(connection.closed).toBe(false)
  expect(await statusTexts()).toEqual([])
})

it('dismisses a question card a finished turn raised, leaving the turn running now alone', async () => {
  const connection = fixture.claude.connections[0]!
  const earlier = await openTurn(connection)
  const { answered, card } = await ask(connection, 'AskUserQuestion', BRANCH_QUESTION)
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1' })
  await eventually(async () =>
    expect(
      activeStructuredAgentSessionTurnId((await fixture.host.journalSnapshot(SESSION)).items)
    ).toBeNull()
  )
  const running = await openTurn(connection, 'Now something else.')
  expect(running).not.toBe(earlier)

  await expect(cancelCard(earlier, card)).resolves.toMatchObject({ ok: true })
  await laneDrained()

  expect(await answered.promise).toMatchObject({ behavior: 'deny' })
  expect(await cardResolution(card.itemId)).toMatchObject({
    state: 'cancelled',
    resolvedBy: CALLER.callerKey
  })
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(connection.closed).toBe(false)
  expect(
    activeStructuredAgentSessionTurnId((await fixture.host.journalSnapshot(SESSION)).items)
  ).toBe(running)
})
