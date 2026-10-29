import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  THREAD_ID
} from '../../codex/codex-structured-session-adapter-fixture'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

it('steers inherited applied inputs and sends an explicit effort or tier change on the next turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-applied-inputs-'))
  const opened = () => ({
    thread: { id: THREAD_ID },
    model: 'model-a',
    reasoningEffort: 'high'
  })
  const codex = fakeCodex({
    'thread/start': opened,
    'thread/resume': opened,
    'config/read': () => ({ config: { service_tier: 'priority' } })
  })
  const openTurn = (turnId: string) => (params: Record<string, unknown> | undefined) => {
    const answer = answerWithOpenedTurn(codex, turnId)(params)
    codex.connections[0].handlers.onNotification?.('item/completed', {
      threadId: THREAD_ID,
      turnId,
      item: {
        type: 'userMessage',
        id: `user-${turnId}`,
        clientId: params?.clientUserMessageId,
        content: []
      }
    })
    return answer
  }
  codex.routes['turn/start'] = openTurn('turn-low')
  codex.routes['turn/steer'] = (params) => ({ turnId: params?.expectedTurnId })
  const adapter = adapterFor(codex, {}, [], {
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    onEvent: (event) => {
      if (event.type === 'options-reported' || (event.type === 'ended' && 'cause' in event)) {
        void host.handleAdapterEvent(event)
      }
    }
  })
  const store = await openTestAgentSessionRecordStore(root)
  const host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => HOST_TEST_NOW
  })
  const caller = { callerKey: 'client-1' }
  const calls = (method: string) =>
    codex.connections[0].calls.filter((call) => call.method === method)
  const eventually = (assertion: () => void | Promise<void>) =>
    vi.waitFor(assertion, { timeout: 10_000 })
  async function send(options: Record<string, string>) {
    // Supply the already-captured boundary: saved-intent merging is owned upstream.
    await store.replaceSessionOptions({
      sessionId: SESSION,
      fence: 1,
      options: {},
      now: HOST_TEST_NOW
    })
    const body = hostTestMessage('continue')
    const clientOperationId = hostTestOperationId()
    expect(
      await host.send(caller, {
        envelope: {
          sessionId: SESSION,
          clientOperationId,
          expectedRuntimeFence: 1,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body, options }
          })
        },
        body,
        options
      })
    ).toMatchObject({ ok: true })
    return clientOperationId
  }
  async function finish(turnId: string) {
    codex.connections[0].handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: turnId, status: 'completed' }
    })
    await host.flushStreamedEvents(SESSION)
  }
  async function expectHeld(id: string, starts: number, steers: number) {
    const { loop } = host.collaboratorsForTests().conversationDelivery
    await eventually(() => expect(loop.isRunning(SESSION)).toBe(false))
    const submission = (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === id
    )
    expect(submission).toMatchObject({ dispatchState: 'pending' })
    expect(submission?.handedOverAt).toBeUndefined()
    expect(calls('turn/start')).toHaveLength(starts)
    expect(calls('turn/steer')).toHaveLength(steers)
  }
  try {
    resetHostTestOperationIds()
    expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
    await send({ model: 'model-a', effort: 'low' })
    await eventually(() => expect(calls('turn/start')).toHaveLength(1))
    expect(calls('turn/start')[0].params).toMatchObject({
      model: 'model-a',
      effort: 'low'
    })
    expect(calls('turn/start')[0].params).not.toHaveProperty('serviceTier')
    expect(await adapter.readOptions({ sessionId: SESSION, fence: 1 })).toMatchObject({
      current: { effort: 'low' }
    })
    await finish('turn-low')

    codex.routes['turn/start'] = openTurn('turn-sparse')
    await send({ model: 'model-a' })
    await eventually(() => expect(calls('turn/start')).toHaveLength(2))
    expect(calls('turn/start')[1].params).not.toHaveProperty('effort')
    expect(calls('turn/start')[1].params).not.toHaveProperty('serviceTier')
    expect(await adapter.readOptions({ sessionId: SESSION, fence: 1 })).toMatchObject({
      current: { effort: 'low' }
    })
    await send({ model: 'model-a' })
    await eventually(() => expect(calls('turn/steer')).toHaveLength(1))
    expect(calls('turn/steer')[0].params).not.toHaveProperty('effort')

    const high = await send({ model: 'model-a', effort: 'high' })
    await expectHeld(high, 2, 1)
    codex.routes['turn/start'] = openTurn('turn-high')
    await finish('turn-sparse')
    await eventually(() => expect(calls('turn/start')).toHaveLength(3))
    expect(calls('turn/start')[2].params).toMatchObject({ model: 'model-a', effort: 'high' })
    expect(calls('turn/start')[2].params).not.toHaveProperty('serviceTier')

    await send({ model: 'model-a', serviceTier: 'priority' })
    await eventually(() => expect(calls('turn/steer')).toHaveLength(2))
    const tier = await send({ model: 'model-a', serviceTier: 'flex' })
    await expectHeld(tier, 3, 2)
    codex.routes['turn/start'] = openTurn('turn-flex')
    await finish('turn-high')
    await eventually(() => expect(calls('turn/start')).toHaveLength(4))
    expect(calls('turn/start')[3].params).toMatchObject({
      model: 'model-a',
      serviceTier: 'flex'
    })
    expect(calls('turn/start')[3].params).not.toHaveProperty('effort')
    await send({ model: 'model-a' })
    await eventually(() => expect(calls('turn/steer')).toHaveLength(3))
    expect(calls('turn/start')).toHaveLength(4)
    const personality = await send({ personality: 'friendly' })
    await expectHeld(personality, 4, 3)
    codex.routes['turn/start'] = openTurn('turn-personality')
    await finish('turn-flex')
    await eventually(() => expect(calls('turn/start')).toHaveLength(5))
    expect(calls('turn/start')[4].params).toMatchObject({ personality: 'friendly' })
    await send({})
    await eventually(() => expect(calls('turn/steer')).toHaveLength(4))
    expect('model' in (calls('turn/steer')[3].params ?? {})).toBe(false)
    expect('effort' in (calls('turn/steer')[3].params ?? {})).toBe(false)
    expect('personality' in (calls('turn/steer')[3].params ?? {})).toBe(false)
    expect('serviceTier' in (calls('turn/steer')[3].params ?? {})).toBe(false)
    expect(
      adapter.readAppliedInputOptions({
        sessionId: SESSION,
        fence: 2,
        acquisitionGeneration: 'generation-1',
        next: {}
      })
    ).toBeNull()
    expect(
      adapter.readAppliedInputOptions({
        sessionId: SESSION,
        fence: 1,
        acquisitionGeneration: 'superseded',
        next: {}
      })
    ).toBeNull()
  } finally {
    await host.flushAllStreamedEvents()
    await adapter.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
