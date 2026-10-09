import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { classifyDispatchRejection } from '../../shared/structured-agent-session-dispatch-rejection'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import {
  acquiredCodexAdapter,
  CODEX_TEST_THREAD_ID,
  CODEX_TEST_USER_MESSAGE,
  fakeCodexAppServer,
  type LateSettlement
} from './codex-structured-dispatch-test-support'
import { codexTurnLifecycleFake } from './codex-turn-lifecycle-fake'

async function turnEndRig() {
  const codex = fakeCodexAppServer()
  const turns = codexTurnLifecycleFake(CODEX_TEST_THREAD_ID, () => {
    const handlers = codex.connections.at(-1)?.handlers
    return (method, params) => handlers?.onNotification?.(method, params)
  })
  Object.assign(codex.routes, turns.routes)
  const settlements: LateSettlement[] = []
  const bodies: AgentJournalItemBody[] = []
  const turnRecords: AgentJournalItemIdentity[] = []
  const adapter = await acquiredCodexAdapter({
    codex,
    settlements,
    sink: {
      appendItem: (identity, body) => {
        bodies.push(body)
        if (body.kind === 'turn') {
          turnRecords.push(identity)
        }
      },
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const send = (clientMessageId: string) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId,
      body: CODEX_TEST_USER_MESSAGE,
      fence: 7
    })
  // Codex answers a cold send before it opens the turn.
  const sendAndOpen = async (clientMessageId: string) => {
    const sending = send(clientMessageId)
    await vi.waitFor(() => expect(turns.turnId).not.toBeNull())
    turns.start()
    return sending
  }
  const settledIds = () => settlements.map(({ clientMessageId }) => clientMessageId)
  const categoryOf = (settlement: LateSettlement | undefined) =>
    settlement && 'state' in settlement ? classifyDispatchRejection(settlement).category : null
  return {
    codex,
    turns,
    adapter,
    send,
    sendAndOpen,
    settlements,
    settledIds,
    categoryOf,
    bodies,
    turnRecords
  }
}

describe('a Codex send its turn ended without echoing', () => {
  it('is withdrawn when the turn is interrupted, once', async () => {
    const rig = await turnEndRig()
    await expect(rig.sendAndOpen('client-1')).resolves.toEqual({ state: 'admitted' })

    rig.turns.end('interrupted')

    expect(rig.settlements).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        state: 'rejected'
      })
    ])
    expect(rig.categoryOf(rig.settlements[0])).toBe('withdrawn')
  })

  it('is rejected in Codex words when its failed turn ends without echoing it', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')

    rig.codex.connections[0]!.handlers.onNotification?.('error', {
      threadId: CODEX_TEST_THREAD_ID,
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'usage limit reached' }
    })
    rig.turns.end('failed', 'usage limit reached')

    expect(rig.settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-1',
        state: 'rejected',
        rejection: {
          kind: 'providerRejected',
          detail: { text: 'usage limit reached', audience: 'log' }
        }
      })
    ])
  })

  it('is accepted when Codex records it after the error that fails its turn', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')
    rig.turns.echo('client-1')
    await rig.send('client-2')

    // A failed turn keeps its steered input: Codex records it after the error, before the end.
    rig.codex.connections[0]!.handlers.onNotification?.('error', {
      threadId: CODEX_TEST_THREAD_ID,
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'usage limit reached' }
    })
    rig.turns.echo('client-2')
    rig.turns.end('failed', 'usage limit reached')

    expect(rig.settlements).toEqual([
      expect.objectContaining({ clientMessageId: 'client-1', providerIdentity: expect.anything() }),
      expect.objectContaining({
        clientMessageId: 'client-2',
        providerIdentity: expect.objectContaining({ turnId: 'turn-1' })
      })
    ])
  })

  it('stays pending, still armed, when its turn completes without echoing it', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')

    rig.turns.end('completed')
    expect(rig.settlements).toEqual([])

    // Codex echoes before a completed end; this late one only proves the send is still armed.
    rig.turns.echo('client-1')
    expect(rig.settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-1',
        providerIdentity: expect.objectContaining({ turnId: 'turn-1' })
      })
    ])
  })

  it('accepts a send its turn echoed, with its key, exactly once', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')
    rig.turns.echo('client-1')

    rig.turns.end('interrupted')

    expect(rig.settlements).toEqual([
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

  it('ignores an echo that arrives after the withdrawal', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')
    rig.turns.end('interrupted')

    rig.turns.echo('client-1')

    expect(rig.settledIds()).toEqual(['client-1'])
    expect(rig.categoryOf(rig.settlements[0])).toBe('withdrawn')
  })

  it('settles each of two sends steered into one interrupted turn once', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')
    await rig.send('client-2')
    expect(rig.turns.turnId).toBe('turn-1')

    rig.turns.end('interrupted')

    expect(rig.settledIds().sort()).toEqual(['client-1', 'client-2'])
  })

  it('settles a send whose answer arrived after turn/started when the turn is interrupted', async () => {
    const rig = await turnEndRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    release()
    await expect(sending).resolves.toEqual({ state: 'admitted' })

    rig.turns.end('interrupted')

    expect(rig.settledIds()).toEqual(['client-1'])
  })

  it('settles a send by the recorded end of a turn that finished before its answer arrived', async () => {
    const rig = await turnEndRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    rig.turns.end('interrupted')
    const rowsAtEnd = rig.bodies.filter((body) => body.kind === 'turn').length
    release()

    const outcome = await sending
    expect(outcome.state === 'rejected' && classifyDispatchRejection(outcome).category).toBe(
      'withdrawn'
    )
    expect(rig.settlements).toEqual([])
    // The answer opens nothing: the turn keeps its terminal row.
    expect(rig.bodies.filter((body) => body.kind === 'turn')).toHaveLength(rowsAtEnd)
    expect(rig.bodies.findLast((body) => body.kind === 'turn')).toMatchObject({
      state: 'interrupted'
    })
  })

  it('rejects a send in Codex words by the recorded end of a failed turn that finished before its answer', async () => {
    const rig = await turnEndRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    rig.turns.end('failed', 'usage limit reached')
    release()

    await expect(sending).resolves.toMatchObject({
      state: 'rejected',
      rejection: {
        kind: 'providerRejected',
        detail: { text: 'usage limit reached', audience: 'log' }
      }
    })
    // Settled once, by the answer: a late echo is no longer owed anything.
    rig.turns.echo('client-1')
    expect(rig.settlements).toEqual([])
  })

  it('leaves a send pending, still armed, when its answer is read after its turn completed', async () => {
    const rig = await turnEndRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    rig.turns.end('completed')
    release()

    await expect(sending).resolves.toEqual({ state: 'admitted' })
    expect(rig.settlements).toEqual([])
    rig.turns.echo('client-1')
    expect(rig.settledIds()).toEqual(['client-1'])
    expect(rig.settlements[0]).toHaveProperty('providerIdentity')
  })

  it('leaves a send whose answer timed out to its echo', async () => {
    const rig = await turnEndRig()
    rig.codex.routes['turn/start'] = () => {
      throw new Error('codex app-server turn/start exceeded 30000ms')
    }
    await expect(rig.send('client-1')).rejects.toThrow('exceeded')

    rig.codex.connections[0]!.handlers.onNotification?.('turn/started', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-9' }
    })
    rig.codex.connections[0]!.handlers.onNotification?.('item/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-9' },
      item: { type: 'userMessage', id: 'item-9', clientId: 'client-1', content: [] }
    })

    expect(rig.settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-1',
        providerIdentity: expect.objectContaining({ turnId: 'turn-9' })
      })
    ])
  })

  it('ignores a turn end on a child thread', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')

    rig.codex.connections[0]!.handlers.onNotification?.('turn/completed', {
      threadId: 'thread-child',
      turn: { id: 'turn-1', status: 'interrupted' }
    })

    expect(rig.settlements).toEqual([])
  })
})

describe('the turn a withdrawn Codex send names', () => {
  it('is the record of the turn it opened, when that turn is interrupted', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')

    rig.turns.end('interrupted')

    expect(rig.turnRecords.length).toBeGreaterThan(0)
    expect(new Set(rig.turnRecords.map(agentJournalItemKey)).size).toBe(1)
    expect(rig.settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-1',
        answeredInTurn: { turn: rig.turnRecords[0], via: 'start' }
      })
    ])
  })

  it('is the running turn for a send steered into it', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')
    await rig.send('client-2')

    rig.turns.end('interrupted')

    expect(rig.settlements.map((settlement) => [settlement.clientMessageId, settlement])).toEqual([
      [
        'client-1',
        expect.objectContaining({ answeredInTurn: { turn: rig.turnRecords[0], via: 'start' } })
      ],
      [
        'client-2',
        expect.objectContaining({ answeredInTurn: { turn: rig.turnRecords[0], via: 'steer' } })
      ]
    ])
  })

  it('is the ended turn whose end was read before the answer', async () => {
    const rig = await turnEndRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    rig.turns.end('interrupted')
    release()

    await expect(sending).resolves.toMatchObject({
      state: 'rejected',
      answeredInTurn: { turn: rig.turnRecords[0], via: 'start' }
    })
  })

  it('is not named when its turn completes without echoing it: the send stays pending', async () => {
    const rig = await turnEndRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    rig.turns.end('completed')
    release()

    await expect(sending).resolves.toEqual({ state: 'admitted' })
    await rig.sendAndOpen('client-2')
    rig.turns.end('completed')
    expect(rig.settlements).toEqual([])
  })
})

describe('a send bound to a turn', () => {
  it('dies with the settlement its turn end makes', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.bindTurn('client-1', 'thread-1', 'turn-1', 'start')

    expect(echoes.endTurn('thread-1', 'turn-1', { status: 'interrupted' })).toEqual([
      { clientMessageId: 'client-1', via: 'start' }
    ])
    expect(echoes.size).toBe(0)
    expect(echoes.settle('client-1')).toBe(false)
  })

  it('dies with its child, which forgets recorded turn ends too', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.bindTurn('client-1', 'thread-1', 'turn-1', 'start')
    echoes.endTurn('thread-2', 'turn-2', { status: 'interrupted' })

    echoes.clear()

    expect(echoes.size).toBe(0)
    echoes.arm('client-2')
    expect(echoes.bindTurn('client-2', 'thread-2', 'turn-2', 'start')).toBeNull()
  })

  it('is matched by thread as well as turn id', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.bindTurn('client-1', 'thread-1', 'turn-1', 'start')

    expect(echoes.endTurn('thread-2', 'turn-1', { status: 'interrupted' })).toEqual([])
    expect(echoes.size).toBe(1)
  })
})

it('settles the first un-echoed unauthorized turn as signed out, with Codex detail', async () => {
  const rig = await turnEndRig()
  await rig.sendAndOpen('auth-first')
  const error = { codexErrorInfo: 'unauthorized', message: 'The authentication token has expired.' }
  const notify = rig.codex.connections[0]?.handlers.onNotification
  notify?.('error', { threadId: CODEX_TEST_THREAD_ID, turnId: 'turn-1', willRetry: false, error })
  notify?.('turn/completed', {
    threadId: CODEX_TEST_THREAD_ID,
    turn: { id: 'turn-1', status: 'failed', error }
  })
  expect(rig.settlements).toEqual([
    expect.objectContaining({
      clientMessageId: 'auth-first',
      state: 'rejected',
      rejection: { kind: 'notSignedIn', detail: { text: error.message, audience: 'person' } }
    })
  ])
  expect(
    rig.settlements[0] && 'reason' in rig.settlements[0] ? rig.settlements[0].reason : ''
  ).toContain('codex login')
})
