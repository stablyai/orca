import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { MAX_CODEX_PENDING_DISPATCH_ECHOES } from './codex-structured-dispatch-echo'
import {
  acquiredCodexAdapter,
  echoUserMessage,
  fakeCodexAppServer,
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

  it('names a hook-refused send as its turn opener when its turn ends in the reply chunk', async () => {
    const codex = fakeCodexAppServer()
    const recorded = lifecycleRecorder()
    const adapter = await acquiredCodexAdapter({ codex, settlements: [], sink: recorded.sink })
    const connection = codex.connections[0]!
    const request = connection.request
    // One stdout chunk: the reply, then the whole refused turn, before the reply's continuation.
    connection.request = async (method, params, options) => {
      if (method !== 'turn/start') {
        return request(method, params, options)
      }
      const reply = { turn: { id: 'turn-1', status: 'inProgress' } }
      options?.onReply?.(reply)
      startTurn(connection, 'turn-1')
      connection.handlers.onNotification?.('turn/completed', {
        threadId: CODEX_TEST_THREAD_ID,
        turn: { id: 'turn-1', status: 'completed' }
      })
      return reply
    }

    expect(await send(adapter, 'client-refused', 1_700_000_000_100)).toMatchObject({
      state: 'admitted'
    })
    expect(recorded.bodies.filter((body) => body.kind === 'turn')).toMatchObject([
      { state: 'running', userItemId: agentJournalSubmissionKey('client-refused') },
      {
        state: 'completed',
        requestedAt: 1_700_000_000_100,
        userItemId: agentJournalSubmissionKey('client-refused')
      }
    ])
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
