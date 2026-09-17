import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { MAX_CODEX_PENDING_DISPATCH_ECHOES } from './codex-structured-dispatch-echo'
import type { CodexStructuredSessionEvent } from './codex-structured-session-state'
import {
  acquiredCodexAdapter,
  echoUserMessage,
  fakeCodexAppServer,
  recordingSink,
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
  it('settles a successful steer with its exact active turn', async () => {
    const codex = fakeCodexAppServer({
      'turn/steer': () => ({ turnId: 'turn-1' })
    })
    const settlements: LateSettlement[] = []
    const ownerEnded: string[][] = []
    const sink = recordingSink()
    sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
      if (options?.ownerEndedClientMessageIds) {
        ownerEnded.push([...options.ownerEndedClientMessageIds])
      }
      return { accepted: true }
    }
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')

    await expect(send(adapter, 'client-1')).resolves.toEqual({ state: 'admitted' })
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-1', status: 'completed' }
    })
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })

    expect(ownerEnded).toEqual([['client-1']])
    expect(settlements).toEqual([expect.objectContaining({ clientMessageId: 'client-1' })])
  })

  it('late-settles when an interrupted terminal event precedes the steer response', async () => {
    let completeTurn: (() => void) | undefined
    const codex = fakeCodexAppServer({
      'turn/steer': () => {
        completeTurn?.()
        return { turnId: 'turn-1' }
      }
    })
    const settlements: LateSettlement[] = []
    const ownerEnded: string[][] = []
    const sink = recordingSink()
    sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
      ownerEnded.push([...(options?.ownerEndedClientMessageIds ?? [])])
      return { accepted: true }
    }
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    completeTurn = () =>
      connection.handlers.onNotification?.('turn/completed', {
        threadId: CODEX_TEST_THREAD_ID,
        turn: { id: 'turn-1', status: 'interrupted' }
      })

    await expect(send(adapter, 'client-1')).resolves.toEqual({ state: 'admitted' })
    expect(ownerEnded).toEqual([[]])

    expect(settlements).toEqual([
      {
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        state: 'unknown',
        reason: 'turn_settled_before_acknowledgement',
        recovered: true,
        turnId: 'turn-1'
      }
    ])
  })

  it('late-settles when a fresh-start terminal event precedes its response', async () => {
    let connection: ReturnType<typeof fakeCodexAppServer>['connections'][number] | undefined
    const codex = fakeCodexAppServer({
      'turn/start': () => {
        connection?.handlers.onNotification?.('turn/completed', {
          threadId: CODEX_TEST_THREAD_ID,
          turn: { id: 'turn-new', status: 'completed' }
        })
        return { turn: { id: 'turn-new' } }
      }
    })
    const settlements: LateSettlement[] = []
    const ownerEnded: string[][] = []
    const sink = recordingSink()
    sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
      ownerEnded.push([...(options?.ownerEndedClientMessageIds ?? [])])
      return { accepted: true }
    }
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink })
    connection = codex.connections[0]!

    await expect(send(adapter, 'client-1')).resolves.toEqual({ state: 'admitted' })

    expect(ownerEnded).toEqual([[]])
    expect(settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-1',
        state: 'unknown',
        recovered: true,
        turnId: 'turn-new'
      })
    ])
  })

  it.each(['response-first', 'started-first'] as const)(
    'requires a fresh-start response and started event (%s)',
    async (ordering) => {
      let connection: ReturnType<typeof fakeCodexAppServer>['connections'][number] | undefined
      const codex = fakeCodexAppServer({
        'turn/start': () => {
          if (ordering === 'started-first' && connection) {
            startTurn(connection, 'turn-new')
          }
          return { turn: { id: 'turn-new' } }
        }
      })
      const ownerEnded: string[][] = []
      const sink = recordingSink()
      sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
        ownerEnded.push([...(options?.ownerEndedClientMessageIds ?? [])])
        return { accepted: true }
      }
      const adapter = await acquiredCodexAdapter({ codex, settlements: [], sink })
      connection = codex.connections[0]!

      await expect(send(adapter, 'client-1')).resolves.toEqual({ state: 'admitted' })
      if (ordering === 'response-first') {
        startTurn(connection, 'turn-new')
      }
      connection.handlers.onNotification?.('turn/completed', {
        threadId: CODEX_TEST_THREAD_ID,
        turn: { id: 'turn-new', status: 'completed' }
      })

      expect(ownerEnded).toEqual([['client-1']])
    }
  )

  it('does not bind a stale active snapshot when the provider has advanced', async () => {
    const { CodexAppServerRequestError } = await import('./codex-app-server-connection')
    let connection: ReturnType<typeof fakeCodexAppServer>['connections'][number] | undefined
    const codex = fakeCodexAppServer({
      'turn/steer': () => {
        connection?.handlers.onNotification?.('turn/completed', {
          threadId: CODEX_TEST_THREAD_ID,
          turn: { id: 'turn-a', status: 'completed' }
        })
        if (connection) {
          startTurn(connection, 'turn-b')
        }
        throw new CodexAppServerRequestError(
          'turn/steer',
          -32602,
          'expected active turn id turn-a but found turn-b'
        )
      },
      // An older provider may answer this while keeping turn-b active. Without
      // a matching started event, turn-submission is not proven ownership.
      'turn/start': () => ({ turn: { id: 'turn-submission' } })
    })
    const settlements: LateSettlement[] = []
    const ownerEnded: string[][] = []
    const sink = recordingSink()
    sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
      ownerEnded.push([...(options?.ownerEndedClientMessageIds ?? [])])
      return { accepted: true }
    }
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink })
    connection = codex.connections[0]!
    startTurn(connection, 'turn-a')

    await expect(send(adapter, 'client-1')).resolves.toEqual({ state: 'admitted' })
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-b', status: 'completed' }
    })

    expect(ownerEnded).toEqual([[], []])
    echoUserMessage(connection, {
      turnId: 'turn-b',
      itemId: 'item-u1',
      clientId: 'client-1'
    })
    expect(settlements).toEqual([expect.objectContaining({ clientMessageId: 'client-1' })])
  })

  it('falls back after a no-active steer and preserves exact fresh-turn ownership', async () => {
    const { CodexAppServerRequestError } = await import('./codex-app-server-connection')
    let connection: ReturnType<typeof fakeCodexAppServer>['connections'][number] | undefined
    const codex = fakeCodexAppServer({
      'turn/steer': () => {
        throw new CodexAppServerRequestError('turn/steer', -32602, 'no active turn to steer')
      },
      'turn/start': () => {
        if (connection) {
          startTurn(connection, 'turn-new')
        }
        return { turn: { id: 'turn-new' } }
      }
    })
    const ownerEnded: string[][] = []
    const sink = recordingSink()
    sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
      ownerEnded.push([...(options?.ownerEndedClientMessageIds ?? [])])
      return { accepted: true }
    }
    const adapter = await acquiredCodexAdapter({ codex, settlements: [], sink })
    connection = codex.connections[0]!
    startTurn(connection, 'stale-local-turn')

    await expect(send(adapter, 'client-1')).resolves.toEqual({ state: 'admitted' })
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-new', status: 'completed' }
    })

    expect(ownerEnded).toEqual([['client-1']])
    expect(connection.calls.map(({ method }) => method)).toContain('turn/steer')
    expect(connection.calls.map(({ method }) => method)).toContain('turn/start')
  })

  it('keeps an unsupported-steer fallback pending when start returns only a phantom id', async () => {
    const { CodexAppServerUnsupportedError } = await import('./codex-app-server-session')
    const codex = fakeCodexAppServer({
      'turn/steer': () => {
        throw new CodexAppServerUnsupportedError('turn/steer: method not found')
      },
      'turn/start': () => ({ turn: { id: 'phantom-turn' } })
    })
    const settlements: LateSettlement[] = []
    const ownerEnded: string[][] = []
    const sink = recordingSink()
    sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
      ownerEnded.push([...(options?.ownerEndedClientMessageIds ?? [])])
      return { accepted: true }
    }
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-active')

    await expect(send(adapter, 'client-1')).resolves.toEqual({ state: 'admitted' })
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-active', status: 'completed' }
    })

    expect(ownerEnded).toEqual([[]])
    echoUserMessage(connection, {
      turnId: 'turn-active',
      itemId: 'item-u1',
      clientId: 'client-1'
    })
    expect(settlements).toEqual([expect.objectContaining({ clientMessageId: 'client-1' })])
  })

  it('does not bind a successful steer response naming another turn', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-other' }) })
    const settlements: LateSettlement[] = []
    const ownerEnded: string[][] = []
    const sink = recordingSink()
    sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
      ownerEnded.push([...(options?.ownerEndedClientMessageIds ?? [])])
      return { accepted: true }
    }
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-active')

    await expect(send(adapter, 'client-1')).resolves.toEqual({ state: 'admitted' })
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-active', status: 'completed' }
    })

    expect(ownerEnded).toEqual([[]])
    echoUserMessage(connection, {
      turnId: 'turn-active',
      itemId: 'item-u1',
      clientId: 'client-1'
    })
    expect(settlements).toEqual([expect.objectContaining({ clientMessageId: 'client-1' })])
  })

  it('admits a send queued behind a running turn and settles it when Codex echoes it', async () => {
    const codex = fakeCodexAppServer({
      'turn/steer': () => ({ turnId: 'turn-1' })
    })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    settlements.length = 0

    const outcome = await send(adapter, 'client-2')

    // No doubt: elapsed time is not evidence, so nothing invites a Retry.
    expect(outcome).toEqual({ state: 'admitted' })
    expect(settlements).toEqual([])

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u2', clientId: 'client-2' })

    // Ordinal 1, not 0: the queued send is the SECOND user message of the turn
    // it was coalesced into, which is the key a history replay computes for it.
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

    // The echoes arrive in the opposite order to the sends.
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u2', clientId: 'client-2' })
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })

    // Ordinals follow the ECHO order, and each one lands on the send whose
    // `clientId` it carried -- not on the send that was queued in that slot.
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

  it('forwards every correlated live echo for durable host validation', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    await send(adapter, 'client-1')

    // The adapter cannot prove ownership after bounded tracking overflows. The
    // host checks this exact id against its durable same-fence submission.
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-x', clientId: 'someone-else' })
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-y' })

    expect(settlements).toEqual([expect.objectContaining({ clientMessageId: 'someone-else' })])
  })

  it('forces provider recovery when durable echo settlement fails', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquiredCodexAdapter({
      codex,
      settlements: [],
      events,
      settleLateDispatch: async (settlement) => {
        if ('providerIdentity' in settlement) {
          throw new Error('journal settlement failed')
        }
        return 'evidence-not-durable'
      }
    })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    await send(adapter, 'client-1')

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })

    await vi.waitFor(() => expect(connection.closed).toBe(true))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        cause: 'unexpected-exit',
        reason: 'journal settlement failed'
      })
    )
  })

  it('retries durable echo settlement when provider exit cannot be proven', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    let echoAttempts = 0
    const adapter = await acquiredCodexAdapter({
      codex,
      settlements: [],
      settleLateDispatch: async (settlement) => {
        if ('turnId' in settlement) {
          return 'evidence-not-durable'
        }
        echoAttempts += 1
        if (echoAttempts === 1) {
          throw new Error('journal settlement failed')
        }
        return 'settled'
      }
    })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    await send(adapter, 'client-1')
    const close = vi.fn(async () => false)
    const originalClose = connection.close
    connection.close = close
    try {
      echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
      await new Promise((resolve) => setTimeout(resolve, 40))
      startTurn(connection, 'turn-2')

      await vi.waitFor(() => expect(echoAttempts).toBe(2))
      expect(close).toHaveBeenCalledOnce()
    } finally {
      connection.close = originalClose
      await adapter.closeSession('session-1')
    }
  })

  it('forces provider recovery when terminal-before-response settlement fails', async () => {
    let completeTurn: (() => void) | undefined
    const codex = fakeCodexAppServer({
      'turn/steer': () => {
        completeTurn?.()
        return { turnId: 'turn-1' }
      }
    })
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquiredCodexAdapter({
      codex,
      settlements: [],
      events,
      settleLateDispatch: async (settlement) => {
        if ('turnId' in settlement) {
          throw new Error('terminal settlement failed')
        }
        return 'evidence-not-durable'
      }
    })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    completeTurn = () =>
      connection.handlers.onNotification?.('turn/completed', {
        threadId: CODEX_TEST_THREAD_ID,
        turn: { id: 'turn-1', status: 'interrupted' }
      })

    await send(adapter, 'client-1')

    await vi.waitFor(() => expect(connection.closed).toBe(true))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        cause: 'unexpected-exit',
        reason: 'terminal settlement failed'
      })
    )
  })

  it('retries terminal-before-response settlement when provider exit cannot be proven', async () => {
    let completeTurn: (() => void) | undefined
    const codex = fakeCodexAppServer({
      'turn/steer': () => {
        completeTurn?.()
        return { turnId: 'turn-1' }
      }
    })
    let terminalAttempts = 0
    const adapter = await acquiredCodexAdapter({
      codex,
      settlements: [],
      settleLateDispatch: async (settlement) => {
        if (!('turnId' in settlement)) {
          return 'evidence-not-durable'
        }
        terminalAttempts += 1
        if (terminalAttempts === 1) {
          throw new Error('terminal settlement failed')
        }
        return 'settled'
      }
    })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    completeTurn = () =>
      connection.handlers.onNotification?.('turn/completed', {
        threadId: CODEX_TEST_THREAD_ID,
        turn: { id: 'turn-1', status: 'interrupted' }
      })
    const close = vi.fn(async () => false)
    const originalClose = connection.close
    connection.close = close
    try {
      await send(adapter, 'client-1')

      await vi.waitFor(() => expect(terminalAttempts).toBe(2))
      expect(close).toHaveBeenCalledOnce()
    } finally {
      connection.close = originalClose
      await adapter.closeSession('session-1')
    }
  })

  it('rejects only when Codex answered and declined', async () => {
    const { CodexAppServerRequestError } = await import('./codex-app-server-connection')
    const refuse = (method: string): never => {
      throw new CodexAppServerRequestError(method, -32602, 'thread not found')
    }
    const codex = fakeCodexAppServer({
      'turn/steer': () => refuse('turn/steer'),
      'turn/start': () => refuse('turn/start')
    })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')

    expect(await send(adapter, 'client-1')).toEqual({
      state: 'rejected',
      reason: 'thread not found'
    })

    // A contradictory live echo is forwarded; the durable rejected row makes
    // the host ignore it.
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    expect(settlements).toEqual([expect.objectContaining({ clientMessageId: 'client-1' })])
  })

  it('retains correlation when a request fails after its write may have landed', async () => {
    const codex = fakeCodexAppServer({
      'turn/steer': () => {
        throw new Error('request timed out after write')
      }
    })
    const settlements: LateSettlement[] = []
    const ownerEnded: string[][] = []
    const sink = recordingSink()
    sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
      ownerEnded.push([...(options?.ownerEndedClientMessageIds ?? [])])
      return { accepted: true }
    }
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')

    await expect(send(adapter, 'client-1')).rejects.toThrow('request timed out after write')
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-1', status: 'completed' }
    })
    expect(ownerEnded).toEqual([[]])
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
    await send(adapter, 'client-later', 1_700_000_000_400)
    startTurn(connection, 'turn-later')
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
      'turn/start': () => ({ turn: { id: 'turn-resumed', status: 'inProgress' } })
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
      'turn/start': () => ({ turn: { id: 'turn-1', status: 'inProgress' } })
    })
    const settlements: LateSettlement[] = []
    const recorded = lifecycleRecorder()
    const adapter = await acquiredCodexAdapter({ codex, settlements, sink: recorded.sink })
    const connection = codex.connections[0]!

    await send(adapter, 'client-opening', 1_700_000_000_600)
    await send(adapter, 'client-queued', 1_700_000_000_200)
    startTurn(connection, 'turn-1')
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

    await send(adapter, 'client-late-echo', 1_700_000_000_100)
    startTurn(connection, 'turn-1')
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

  it('admits overflow without discarding older correlations and leaves echo/exit recovery', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    const settlements: LateSettlement[] = []
    const events: CodexStructuredSessionEvent[] = []
    const ownerEnded: string[][] = []
    const sink = recordingSink()
    sink.appendLifecycleBatch = (_settlementId, _mutations, options) => {
      ownerEnded.push([...(options?.ownerEndedClientMessageIds ?? [])])
      return { accepted: true }
    }
    const adapter = await acquiredCodexAdapter({ codex, settlements, events, sink })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')

    for (let index = 0; index < MAX_CODEX_PENDING_DISPATCH_ECHOES; index += 1) {
      expect(await send(adapter, `client-${index}`)).toEqual({ state: 'admitted' })
    }
    await expect(send(adapter, 'client-overflow-echo')).resolves.toEqual({ state: 'admitted' })
    await expect(send(adapter, 'client-overflow-exit')).resolves.toEqual({ state: 'admitted' })
    expect(connection.calls.filter(({ method }) => method === 'turn/steer')).toHaveLength(
      MAX_CODEX_PENDING_DISPATCH_ECHOES + 2
    )

    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-1', status: 'completed' }
    })
    expect(ownerEnded).toHaveLength(1)
    expect(ownerEnded[0]).toHaveLength(MAX_CODEX_PENDING_DISPATCH_ECHOES)
    expect(ownerEnded[0]).toContain('client-0')
    expect(ownerEnded[0]).not.toContain('client-overflow-echo')

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u0', clientId: 'client-0' })
    echoUserMessage(connection, {
      turnId: 'turn-1',
      itemId: 'item-overflow',
      clientId: 'client-overflow-echo'
    })
    expect(settlements.map(({ clientMessageId }) => clientMessageId)).toEqual([
      'client-0',
      'client-overflow-echo'
    ])

    connection.handlers.onExit?.(new Error('codex app-server exited'))
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'ended', sessionId: 'session-1' })
      )
    )
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

  it('forwards a post-exit echo for durable host validation', async () => {
    const codex = fakeCodexAppServer({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    await send(adapter, 'client-1')

    connection.handlers.onExit?.(new Error('codex app-server exited'))

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    expect(settlements).toEqual([expect.objectContaining({ clientMessageId: 'client-1' })])
  })
})
