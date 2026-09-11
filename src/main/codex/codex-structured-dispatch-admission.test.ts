import { describe, expect, it } from 'vitest'
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
  clientMessageId: string
): Promise<unknown> {
  return adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId,
    body: CODEX_TEST_USER_MESSAGE,
    fence: 7
  })
}

describe('codex dispatch admission', () => {
  it('admits a send queued behind a running turn and settles it when Codex echoes it', async () => {
    // Measured on codex-cli 0.153.4: a `turn/start` issued while a turn runs is
    // COALESCED into it -- same turn id back, no second `turn/started`, and the
    // user message echoed only once the running turn reaches it.
    const codex = fakeCodexAppServer({
      'turn/start': () => ({ turn: { id: 'turn-1', status: 'inProgress' } })
    })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })

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
    const codex = fakeCodexAppServer({ 'turn/start': () => ({ turn: { id: 'turn-1' } }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')

    await send(adapter, 'client-1')
    await send(adapter, 'client-2')

    // The echoes arrive in the opposite order to the sends.
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u2', clientId: 'client-2' })
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })

    expect(
      settlements.map((settlement) => [
        settlement.clientMessageId,
        (settlement.providerIdentity as { ordinal: number }).ordinal
      ])
    ).toEqual([
      ['client-2', 0],
      ['client-1', 1]
    ])
  })

  it('settles nothing for a user message this session never sent', async () => {
    const codex = fakeCodexAppServer({ 'turn/start': () => ({ turn: { id: 'turn-1' } }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    await send(adapter, 'client-1')

    // A message another client sent on the same thread, and one Codex did not
    // correlate at all.
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-x', clientId: 'someone-else' })
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-y' })

    expect(settlements).toEqual([])
  })

  it('rejects only when Codex answered and declined, and arms nothing for it', async () => {
    const { CodexAppServerRequestError } = await import('./codex-app-server-connection')
    const codex = fakeCodexAppServer({
      'turn/start': () => {
        throw new CodexAppServerRequestError('turn/start', -32602, 'thread not found')
      }
    })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')

    expect(await send(adapter, 'client-1')).toEqual({
      state: 'rejected',
      reason: 'thread not found'
    })

    // A refused write is disarmed, so a later echo of that id settles nothing.
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    expect(settlements).toEqual([])
  })

  it('leaves no waiter behind when the session closes', async () => {
    const codex = fakeCodexAppServer({ 'turn/start': () => ({ turn: { id: 'turn-1' } }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    await send(adapter, 'client-1')

    await adapter.closeSession('session-1')

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    expect(settlements).toEqual([])
  })

  it('leaves no waiter behind when the child exits', async () => {
    const codex = fakeCodexAppServer({ 'turn/start': () => ({ turn: { id: 'turn-1' } }) })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'turn-1')
    await send(adapter, 'client-1')

    connection.handlers.onExit?.(new Error('codex app-server exited'))

    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    expect(settlements).toEqual([])
  })
})
