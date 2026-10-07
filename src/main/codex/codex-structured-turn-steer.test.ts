// A send made while a Codex turn runs goes in as `turn/steer` naming that turn, so the
// send is bound to the turn that carries it and that turn's end can settle it. A steer
// Codex refuses took no input, so the send steers a turn opened meanwhile, once, or else
// falls back to `turn/start`. A send made before Codex opens an earlier send's turn waits for it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError
} from './codex-app-server-session'
import {
  acquiredCodexAdapter,
  codexTurnLifecycleRig,
  echoUserMessage,
  fakeCodexAppServer,
  settledWithin,
  startTurn,
  CODEX_TEST_THREAD_ID,
  CODEX_TEST_USER_MESSAGE,
  type CodexTestRoute,
  type LateSettlement
} from './codex-structured-dispatch-test-support'
import { CODEX_TURN_OPEN_WAIT_MS } from './codex-structured-turn-open-wait'

async function rig(routes: Record<string, CodexTestRoute>) {
  const codex = fakeCodexAppServer(routes)
  const settlements: LateSettlement[] = []
  const adapter = await acquiredCodexAdapter({ codex, settlements })
  const connection = codex.connections[0]!
  const send = (clientMessageId: string) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId,
      body: CODEX_TEST_USER_MESSAGE,
      fence: 7
    })
  const methods = () =>
    connection.calls
      .map(({ method }) => method)
      .filter((method) => method !== 'model/list' && method !== 'config/read')
  const endTurn = (turnId: string, status: 'completed' | 'interrupted') =>
    connection.handlers.onNotification?.('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: turnId, status }
    })
  return { connection, settlements, send, methods, endTurn }
}

const refusedSteer = (message: string): CodexAppServerRequestError =>
  new CodexAppServerRequestError(
    'turn/steer',
    -32600,
    `codex app-server turn/steer failed: ${message}`,
    message
  )

describe('a Codex send while a turn runs', () => {
  it('steers into that turn by name, and that turn ending unechoed withdraws it', async () => {
    const { connection, settlements, send, methods, endTurn } = await rig({
      'turn/steer': () => ({ turnId: 'turn-1' }),
      // A Codex before 0.148 answers a steered start with a turn that never opens.
      'turn/start': () => ({ turn: { id: 'submission-7' } })
    })
    startTurn(connection, 'turn-1')

    expect(await send('client-1')).toEqual({ state: 'admitted' })
    expect(methods()).toEqual(['thread/start', 'turn/steer'])
    expect(connection.calls.at(-1)?.params).toEqual({
      threadId: CODEX_TEST_THREAD_ID,
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'client-1',
      input: [{ type: 'text', text: 'ship it' }]
    })

    endTurn('turn-1', 'interrupted')

    expect(settlements).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        state: 'rejected',
        rejection: { kind: 'cancelled' }
      })
    ])
  })

  it('settles on its echo when the turn completes with it', async () => {
    const { connection, settlements, send, endTurn } = await rig({
      'turn/steer': () => ({ turnId: 'turn-1' })
    })
    startTurn(connection, 'turn-1')

    expect(await send('client-1')).toEqual({ state: 'admitted' })
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    endTurn('turn-1', 'completed')

    expect(settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-1',
        providerIdentity: expect.objectContaining({ turnId: 'turn-1' })
      })
    ])
  })

  it.each([
    ['the turn ended first', () => refusedSteer('no active turn to steer')],
    [
      'another turn is running',
      () => refusedSteer('expected active turn id `turn-1` but found `turn-2`')
    ],
    ['this Codex has no turn/steer', () => new CodexAppServerUnsupportedError('method not found')]
  ])('falls back to turn/start when Codex refuses the steer because %s', async (_case, error) => {
    const { connection, send, methods } = await rig({
      'turn/steer': () => {
        throw error()
      },
      'turn/start': () => ({ turn: { id: 'turn-2' } })
    })
    startTurn(connection, 'turn-1')

    expect(await send('client-1')).toEqual({ state: 'admitted' })
    expect(methods()).toEqual(['thread/start', 'turn/steer', 'turn/start'])
    expect(connection.calls.at(-1)?.params).toMatchObject({ clientUserMessageId: 'client-1' })
  })

  it('steers once more when Codex refuses because a turn Orca just heard of is running', async () => {
    let steers = 0
    const { connection, settlements, send, methods, endTurn } = await rig({
      'turn/steer': () => {
        steers += 1
        if (steers === 1) {
          // Codex moved on to a turn Orca did not start; its frames land before the refusal is read.
          endTurn('turn-1', 'completed')
          startTurn(connection, 'turn-2')
          throw refusedSteer('expected active turn id `turn-1` but found `turn-2`')
        }
        return { turnId: 'turn-2' }
      }
    })
    startTurn(connection, 'turn-1')

    expect(await send('client-1')).toEqual({ state: 'admitted' })
    expect(methods()).toEqual(['thread/start', 'turn/steer', 'turn/steer'])
    expect(connection.calls.at(-1)?.params).toMatchObject({ expectedTurnId: 'turn-2' })
    endTurn('turn-2', 'interrupted')

    expect(settlements).toEqual([
      expect.objectContaining({ clientMessageId: 'client-1', state: 'rejected' })
    ])
  })

  it('is rejected in Codex words and disarmed when Codex refuses the steer and the start', async () => {
    const { connection, settlements, send, methods } = await rig({
      'turn/steer': () => {
        throw refusedSteer('active turn cannot be steered')
      },
      'turn/start': () => {
        throw new CodexAppServerRequestError(
          'turn/start',
          -32600,
          'codex app-server turn/start failed: thread not found',
          'thread not found'
        )
      }
    })
    startTurn(connection, 'turn-1')

    expect(await send('client-1')).toEqual({
      state: 'rejected',
      reason: 'The provider did not accept this message: thread not found.',
      rejection: {
        kind: 'providerRejected',
        detail: { text: 'thread not found', audience: 'person' }
      }
    })
    expect(methods()).toEqual(['thread/start', 'turn/steer', 'turn/start'])
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
    expect(settlements).toEqual([])
  })

  it('never re-sends a steer that may have landed, and keeps it armed for its echo', async () => {
    const { connection, settlements, send, methods } = await rig({
      'turn/steer': () => {
        throw new CodexAppServerTimeoutError('codex app-server turn/steer exceeded 100ms')
      }
    })
    startTurn(connection, 'turn-1')

    await expect(send('client-1')).rejects.toThrow('turn/steer exceeded')
    expect(methods()).toEqual(['thread/start', 'turn/steer'])
    echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })

    expect(settlements).toEqual([expect.objectContaining({ clientMessageId: 'client-1' })])
  })

  it('starts a turn with no steer when none is running', async () => {
    const { send, methods, endTurn, connection } = await rig({
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    })
    startTurn(connection, 'turn-0')
    endTurn('turn-0', 'completed')

    expect(await send('client-1')).toEqual({ state: 'admitted' })
    expect(methods()).toEqual(['thread/start', 'turn/start'])
  })
})

describe('a Codex send made after Codex answered an earlier one, before it opened that turn', () => {
  /** A Codex before 0.148, which names a steered start falsely and steers only an opened turn. */
  async function answeredUnopened() {
    const rig = await codexTurnLifecycleRig({ legacyStartAnswers: true })
    expect(await rig.send('client-1')).toEqual({ state: 'admitted' })
    const sending = rig.send('client-2')
    expect(await settledWithin(sending)).toBe('held')
    const methods = () =>
      rig.codex.connections[0]!.calls.map(({ method }) => method).filter(
        (method) => method !== 'model/list' && method !== 'config/read'
      )
    expect(methods()).toEqual(['thread/start', 'turn/start'])
    return { ...rig, sending, methods }
  }

  it('waits for that turn to open and steers it, so a Stop withdraws both', async () => {
    const rig = await answeredUnopened()

    rig.turns.start()

    expect(await rig.sending).toEqual({ state: 'admitted' })
    expect(rig.methods()).toEqual(['thread/start', 'turn/start', 'turn/steer'])
    expect(await rig.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).toEqual({
      cancelled: true,
      turnId: 'turn-1'
    })
    // Codex answers the interrupt, then ends the turn, which settles both.
    await vi.waitFor(() =>
      expect(rig.settlements.map(({ clientMessageId }) => clientMessageId).sort()).toEqual([
        'client-1',
        'client-2'
      ])
    )
  })

  it('starts its own turn when that turn ends without opening', async () => {
    const rig = await answeredUnopened()

    rig.turns.end('failed')

    expect(await rig.sending).toEqual({ state: 'admitted' })
    expect(rig.methods()).toEqual(['thread/start', 'turn/start', 'turn/start'])
  })
})

describe('a Codex send after a turn Codex answered and never opened', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for that turn once, and never again', async () => {
    const rig = await codexTurnLifecycleRig({ legacyStartAnswers: true })
    expect(await rig.send('client-1')).toEqual({ state: 'admitted' })
    // Before 0.148 a turn that fails before it starts reports only an `error`.
    rig.turns.failUnopened('invalid turn settings')

    vi.useFakeTimers()
    const waited = rig.send('client-2')
    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS)
    expect(await waited).toEqual({ state: 'admitted' })
    vi.useRealTimers()
    rig.turns.start()
    rig.turns.echo('client-2')
    rig.turns.end('completed')

    expect(await settledWithin(rig.send('client-3'))).toEqual({ state: 'admitted' })
  })
})
