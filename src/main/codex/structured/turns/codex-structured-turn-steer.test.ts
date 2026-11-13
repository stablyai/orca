import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import { CodexAppServerTimeoutError } from '../../app-server/codex-app-server-session'
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
      .filter(
        (method) => !['initialize', 'model/list', 'config/read', 'skills/list'].includes(method)
      )
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
  it.each([true, false])(
    'settles on its echo with client ID=%s when the turn completes with it',
    async (tagged) => {
      const { connection, settlements, send, endTurn } = await rig({
        'turn/steer': () => ({ turnId: 'turn-1' })
      })
      startTurn(connection, 'turn-1')

      expect(await send('client-1')).toMatchObject({ state: 'admitted' })
      if (tagged) {
        echoUserMessage(connection, { turnId: 'turn-1', itemId: 'item-u1', clientId: 'client-1' })
      } else {
        connection.handlers.onNotification?.('item/started', {
          threadId: CODEX_TEST_THREAD_ID,
          turn: { id: 'turn-1' },
          item: {
            type: 'userMessage',
            id: 'item-u1',
            clientId: null,
            content: [{ type: 'text', text: 'ship it' }]
          }
        })
      }
      endTurn('turn-1', 'completed')

      expect(settlements).toEqual([
        expect.objectContaining({
          clientMessageId: 'client-1',
          providerIdentity: expect.objectContaining({ turnId: 'turn-1' })
        })
      ])
    }
  )

  it('steers once more when Codex refuses because a turn Orca just heard of is running', async () => {
    let steers = 0
    const { connection, settlements, send, methods, endTurn } = await rig({
      'turn/steer': () => {
        steers += 1
        if (steers === 1) {
          endTurn('turn-1', 'completed')
          startTurn(connection, 'turn-2')
          throw refusedSteer('expected active turn id `turn-1` but found `turn-2`')
        }
        return { turnId: 'turn-2' }
      }
    })
    startTurn(connection, 'turn-1')

    expect(await send('client-1')).toMatchObject({ state: 'admitted' })
    expect(methods()).toEqual(['thread/start', 'turn/steer', 'turn/steer'])
    expect(connection.calls.at(-1)?.params).toMatchObject({ expectedTurnId: 'turn-2' })
    endTurn('turn-2', 'interrupted')

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
})

describe('a Codex send made after Codex answered an earlier one, before it opened that turn', () => {
  async function answeredUnopened() {
    const rig = await codexTurnLifecycleRig({ legacyStartAnswers: true })
    expect(await rig.send('client-1')).toMatchObject({ state: 'admitted' })
    const sending = rig.send('client-2')
    expect(await settledWithin(sending)).toBe('held')
    const methods = () =>
      rig.codex.connections[0]!.calls.map(({ method }) => method).filter(
        (method) => !['initialize', 'model/list', 'config/read', 'skills/list'].includes(method)
      )
    expect(methods()).toEqual(['thread/start', 'turn/start'])
    return { ...rig, sending, methods }
  }

  it('waits for that turn to open and steers it, with no delivery verdict from Stop', async () => {
    const rig = await answeredUnopened()

    rig.turns.start()

    expect(await rig.sending).toMatchObject({ state: 'admitted' })
    expect(rig.methods()).toEqual(['thread/start', 'turn/start', 'turn/steer'])
    expect(await rig.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).toEqual({
      cancelled: true,
      turnId: 'turn-1'
    })
    expect(rig.settlements).toEqual([])
  })

  it('starts its own turn when that turn ends without opening', async () => {
    const rig = await answeredUnopened()

    rig.turns.end('failed')

    expect(await rig.sending).toMatchObject({ state: 'admitted' })
    expect(rig.methods()).toEqual(['thread/start', 'turn/start', 'turn/start'])
  })
})

describe('a Codex send after a turn Codex answered and never opened', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for that turn once, and never again', async () => {
    const rig = await codexTurnLifecycleRig({ legacyStartAnswers: true })
    expect(await rig.send('client-1')).toMatchObject({ state: 'admitted' })
    // Before 0.148 a turn that fails before it starts reports only an `error`.
    rig.turns.failUnopened('invalid turn settings')

    vi.useFakeTimers()
    const waited = rig.send('client-2')
    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS)
    expect(await waited).toMatchObject({ state: 'admitted' })
    vi.useRealTimers()
    rig.turns.start()
    rig.turns.echo('client-2')
    rig.turns.end('completed')

    expect(await settledWithin(rig.send('client-3'))).toMatchObject({ state: 'admitted' })
  })
})
