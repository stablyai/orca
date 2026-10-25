import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { MAX_CODEX_PENDING_DISPATCH_ECHOES } from './codex-structured-dispatch-echo'
import {
  acquiredCodexAdapter,
  echoUserMessage,
  fakeCodexAppServer,
  openAfterTurnStarts,
  startTurn,
  CODEX_TEST_THREAD_ID,
  CODEX_TEST_USER_MESSAGE,
  type LateSettlement
} from './codex-structured-dispatch-test-support'

function send(
  adapter: Awaited<ReturnType<typeof acquiredCodexAdapter>>,
  clientMessageId: string,
  requestedAt?: number
): Promise<unknown> {
  return adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId,
    body: CODEX_TEST_USER_MESSAGE,
    fence: 7,
    ...(requestedAt === undefined ? {} : { requestedAt })
  })
}

function lifecycleRecorder(): {
  sink: StructuredAgentSessionEventSink
  bodies: AgentJournalItemBody[]
} {
  const bodies: AgentJournalItemBody[] = []
  return {
    bodies,
    sink: {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => {},
      publish: () => {}
    }
  }
}

describe('codex dispatch admission', () => {
  it('admits a send queued behind a running turn and settles it when Codex echoes it', async () => {
    // Steering joins the running turn; the echo arrives when Codex consumes the input.
    const codex = fakeCodexAppServer({
      'turn/steer': () => ({ turnId: 'turn-1' })
    })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1' })

    const outcome = await send(adapter, 'client-2')

    expect(outcome).toMatchObject({ state: 'admitted' })
    expect(settlements).toEqual([])

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u2', clientId: 'client-2' })

    // Match the ordinal history replay assigns to the second user message.
    expect(settlements).toEqual([
      {
        sessionId: 'session-1',
        clientMessageId: 'client-2',
        providerIdentity: {
          provider: 'codex',
          threadId: CODEX_TEST_THREAD_ID,
          turnId: 'turn-1',
          ordinal: 1
        }
      }
    ])
  })

  it('correlates each send by client message id, not queue order', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')

    await send(adapter, 'client-1')
    await send(adapter, 'client-2')

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u2', clientId: 'client-2' })
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })

    expect(settlements).toEqual([
      {
        sessionId: 'session-1',
        clientMessageId: 'client-2',
        providerIdentity: {
          provider: 'codex',
          threadId: CODEX_TEST_THREAD_ID,
          turnId: 'turn-1',
          ordinal: 0
        }
      },
      {
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        providerIdentity: {
          provider: 'codex',
          threadId: CODEX_TEST_THREAD_ID,
          turnId: 'turn-1',
          ordinal: 1
        }
      }
    ])
  })

  it('settles a send only by the id its echo carries', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    await send(adapter, 'client-1')

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-x', clientId: 'someone-else' })
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-y' })

    expect(settlements.map(({ clientMessageId }) => clientMessageId)).toEqual(['someone-else'])
  })

  it('rejects only when Codex answered and declined', async () => {
    const { CodexAppServerRequestError } =
      await import('./app-server/codex-app-server-request-error')
    const codex = fakeCodexAppServer({
      'turn/start': () => {
        throw new CodexAppServerRequestError(
          'turn/start',
          -32602,
          'codex app-server turn/start failed: thread not found',
          'thread not found'
        )
      }
    })
    const adapter = await acquiredCodexAdapter({ codex, settlements: [] })

    expect(await send(adapter, 'client-1')).toEqual({
      state: 'rejected',
      reason: "Codex didn't accept this message: thread not found.",
      rejection: {
        kind: 'providerRejected',
        detail: { text: 'thread not found', audience: 'person' },
        neverReachedAgent: true
      }
    })
  })

  it('retains correlation when a request fails after its write may have landed', async () => {
    const codex = fakeCodexAppServer({
      'turn/start': () => {
        throw new Error('request timed out after write')
      }
    })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!

    await expect(send(adapter, 'client-1')).rejects.toThrow('request timed out after write')
    startTurn(connection, 'turn-1')
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })

    expect(settlements).toEqual([
      {
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        providerIdentity: {
          provider: 'codex',
          threadId: CODEX_TEST_THREAD_ID,
          turnId: 'turn-1',
          ordinal: 0
        }
      }
    ])
  })

  it('does not give a later turn the request time of an abandoned unknown send', async () => {
    let attempt = 0
    const codex = fakeCodexAppServer({
      'turn/start': () => {
        attempt += 1
        if (attempt === 1) {
          throw new Error('request timed out after write')
        }
        return { turn: { id: 'turn-later' } }
      }
    })
    const settlements: LateSettlement[] = []
    const recorded = lifecycleRecorder()
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink: recorded.sink })
    const connection = codex.connections[0]!

    await expect(send(adapter, 'client-unknown', 1_700_000_000_100)).rejects.toThrow(
      'request timed out after write'
    )
    const later = send(adapter, 'client-later', 1_700_000_000_400)
    await openAfterTurnStarts(connection, 2, () => startTurn(connection, 'turn-later'))
    await later
    echoUserMessage(connection, {
      turnId: 'turn-later',
      itemId: 'item-later',
      clientId: 'client-later'
    })
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-later' }
    })

    const turns = recorded.bodies.filter((body) => body.kind === 'turn')
    expect(turns).toMatchObject([
      { turnId: 'turn-later', state: 'running', startedAt: 1_700_000_000_500 },
      {
        turnId: 'turn-later',
        state: 'running',
        requestedAt: 1_700_000_000_400
      },
      {
        turnId: 'turn-later',
        state: 'completed',
        requestedAt: 1_700_000_000_400
      }
    ])
    expect(
      turns.some((turn) => turn.kind === 'turn' && turn.requestedAt === 1_700_000_000_100)
    ).toBe(false)
  })

  it('does not attribute a send armed after an autonomous turn started', async () => {
    const codex = fakeCodexAppServer({
      'turn/steer': () => ({ turnId: 'turn-resumed' })
    })
    const settlements: LateSettlement[] = []
    const recorded = lifecycleRecorder()
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink: recorded.sink })
    const connection = codex.connections[0]!

    startTurn(connection, 'turn-resumed')
    await send(adapter, 'client-mid-turn', 1_700_000_000_100)
    echoUserMessage(connection, {
      turnId: 'turn-resumed',
      itemId: 'item-mid-turn',
      clientId: 'client-mid-turn'
    })

    const turns = recorded.bodies.filter((body) => body.kind === 'turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]).not.toHaveProperty('requestedAt')
    expect(turns[0]).not.toHaveProperty('userItemId', agentJournalSubmissionKey('client-mid-turn'))
    expect(settlements.map(({ clientMessageId }) => clientMessageId)).toEqual(['client-mid-turn'])
  })

  it('keeps the earliest dispatched origin across out-of-order echoes and a clock step', async () => {
    const codex = fakeCodexAppServer({
      'turn/start': () => ({ turn: { id: 'turn-1', status: 'inProgress' } }),
      'turn/steer': () => ({ turnId: 'turn-1' })
    })
    const settlements: LateSettlement[] = []
    const recorded = lifecycleRecorder()
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink: recorded.sink })
    const connection = codex.connections[0]!

    const opening = send(adapter, 'client-opening', 1_700_000_000_600)
    const queued = send(adapter, 'client-queued', 1_700_000_000_200)
    await openAfterTurnStarts(connection, 2, () => startTurn(connection, 'turn-1'))
    await Promise.all([opening, queued])
    await send(adapter, 'client-mid-turn', 1_700_000_000_100)

    echoUserMessage(connection, {
      turnId: 'turn-1',
      itemId: 'item-queued',
      clientId: 'client-queued'
    })
    echoUserMessage(connection, {
      turnId: 'turn-1',
      itemId: 'item-mid-turn',
      clientId: 'client-mid-turn'
    })
    echoUserMessage(connection, {
      turnId: 'turn-1',
      itemId: 'item-opening',
      clientId: 'client-opening'
    })

    expect(
      recorded.bodies
        .filter((body) => body.kind === 'turn' && body.state === 'running')
        .map((body) => (body.kind === 'turn' ? body.requestedAt : undefined))
    ).toEqual([undefined, 1_700_000_000_200, 1_700_000_000_600])
    expect(settlements.map(({ clientMessageId }) => clientMessageId)).toEqual([
      'client-queued',
      'client-mid-turn',
      'client-opening'
    ])
    expect(recorded.bodies.findLast((body) => body.kind === 'turn')).toMatchObject({
      requestedAt: 1_700_000_000_600,
      userItemId: agentJournalSubmissionKey('client-opening')
    })
  })

  it('revises a completed turn when its exact echo arrives late', async () => {
    const codex = fakeCodexAppServer({
      'turn/start': () => ({ turn: { id: 'turn-1', status: 'inProgress' } })
    })
    const settlements: LateSettlement[] = []
    const recorded = lifecycleRecorder()
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink: recorded.sink })
    const connection = codex.connections[0]!

    const sending = send(adapter, 'client-late-echo', 1_700_000_000_100)
    await openAfterTurnStarts(connection, 1, () => startTurn(connection, 'turn-1'))
    await sending
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-1' }
    })
    echoUserMessage(connection, {
      turnId: 'turn-1',
      itemId: 'item-late',
      clientId: 'client-late-echo'
    })

    expect(recorded.bodies.findLast((body) => body.kind === 'turn')).toMatchObject({
      state: 'completed',
      requestedAt: 1_700_000_000_100,
      userItemId: agentJournalSubmissionKey('client-late-echo')
    })
    expect(settlements.map(({ clientMessageId }) => clientMessageId)).toEqual(['client-late-echo'])
  })

  it('refuses overflow without discarding an older accepted send', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')

    for (let index = 0; index < MAX_CODEX_PENDING_DISPATCH_ECHOES; index += 1) {
      expect(await send(adapter, `client-${index}`)).toMatchObject({ state: 'admitted' })
    }
    expect(await send(adapter, 'client-overflow')).toEqual({
      state: 'rejected',
      reason: 'codex structured dispatch queue is full',
      rejection: { kind: 'queueFull' }
    })

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u0', clientId: 'client-0' })
    expect(settlements.map(({ clientMessageId }) => clientMessageId)).toEqual(['client-0'])
  })

  it('leaves no waiter behind when the session closes', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    await send(adapter, 'client-1')

    await adapter.closeSession('session-1')

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    expect(settlements).toEqual([])
  })
})
