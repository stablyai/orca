import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { classifyDispatchRejection } from '../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import {
  acquiredCodexAdapter,
  CODEX_TEST_THREAD_ID,
  CODEX_TEST_USER_MESSAGE,
  fakeCodexAppServer,
  type LateSettlement
} from './codex-structured-dispatch-test-support'
import { codexTurnLifecycleFake } from '../journal/codex-turn-lifecycle-fake'

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
  const sendAndOpen = async (clientMessageId: string) => {
    const outcome = await send(clientMessageId)
    expect(turns.turnId).not.toBeNull()
    turns.start()
    return outcome
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
  it('is accepted when Codex records it after the error that fails its turn', async () => {
    const rig = await turnEndRig()
    await rig.sendAndOpen('client-1')
    rig.turns.echo('client-1')
    await rig.send('client-2')

    // Codex persists failed-turn input between error and turn/completed.
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

    // Artificially late echo verifies correlation survives completion.
    rig.turns.echo('client-1')
    expect(rig.settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-1',
        providerIdentity: expect.objectContaining({ turnId: 'turn-1' })
      })
    ])
  })

  it('leaves a send pending, still armed, when its answer is read after its turn completed', async () => {
    const rig = await turnEndRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    rig.turns.end('completed')
    release()

    await expect(sending).resolves.toMatchObject({ state: 'admitted' })
    expect(rig.settlements).toEqual([])
    rig.turns.echo('client-1')
    expect(rig.settledIds()).toEqual(['client-1'])
    expect(rig.settlements[0]).toHaveProperty('providerIdentity')
  })
})

it('releases an unauthorized turn without deciding whether its un-echoed send was delivered', async () => {
  const rig = await turnEndRig()
  await rig.sendAndOpen('auth-first')
  const error = { codexErrorInfo: 'unauthorized', message: 'The authentication token has expired.' }
  const notify = rig.codex.connections[0]?.handlers.onNotification
  notify?.('error', { threadId: CODEX_TEST_THREAD_ID, turnId: 'turn-1', willRetry: false, error })
  notify?.('turn/completed', {
    threadId: CODEX_TEST_THREAD_ID,
    turn: { id: 'turn-1', status: 'failed', error }
  })
  expect(rig.settlements).toEqual([])
  expect(rig.adapter.heldSends?.('session-1')).toEqual(new Set())
})
