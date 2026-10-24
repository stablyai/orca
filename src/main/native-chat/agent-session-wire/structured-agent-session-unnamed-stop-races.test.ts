import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { publishCodexTurnLifecycle } from '../../codex/codex-structured-journal-translation-turns'
import {
  adapterFor,
  fakeCodex,
  THREAD_ID as CODEX_THREAD
} from '../../codex/codex-structured-session-adapter-fixture'
import { codexTurnLifecycleFake } from '../../codex/codex-turn-lifecycle-fake'
import { settledWithin } from '../../codex/codex-structured-dispatch-test-support'
import { CODEX_TURN_OPEN_WAIT_MS } from '../../codex/codex-structured-turn-open-wait'
import type * as CodexTurnOpenWait from '../../codex/codex-structured-turn-open-wait'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  createRestTestRig,
  REST_TEST_CALLER as CALLER,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

const openWaits = vi.hoisted(() => {
  const state: {
    turnIds: string[]
    ended: string[]
    began: (() => void) | null
    releaseAll: (() => void) | null
  } = { turnIds: [], ended: [], began: null, releaseAll: null }
  return state
})
vi.mock('../../codex/codex-structured-turn-open-wait', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexTurnOpenWait>()
  return {
    ...actual,
    createCodexTurnOpenWaits: () => {
      const waits = actual.createCodexTurnOpenWaits()
      openWaits.releaseAll = waits.releaseAll
      return {
        ...waits,
        wait: (turnId: string, withinMs: number) => {
          openWaits.turnIds.push(turnId)
          const pending = waits.wait(turnId, withinMs)
          openWaits.began?.()
          return pending.then(() => {
            openWaits.ended.push(turnId)
          })
        }
      }
    }
  }
})

let restRig: RestTestRig | undefined
let adapter: CodexStructuredSessionAdapter | undefined
let queuedRig: QueuedMessageTestRig | undefined
beforeEach(() => {
  openWaits.turnIds.length = 0
  openWaits.ended.length = 0
  openWaits.began = null
  openWaits.releaseAll = null
})
afterEach(async () => {
  openWaits.began = null
  openWaits.releaseAll?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await adapter?.closeAll()
  await restRig?.dispose()
  await queuedRig?.dispose()
  restRig = undefined
  adapter = undefined
  queuedRig = undefined
})

function unnamedStop(clientOperationId = hostTestOperationId()) {
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields: {}
      })
    }
  }
}

/** turn/start answered, but no turn/started or user echo has arrived. */
async function admittedCodexSend() {
  const codex = fakeCodex()
  const notify = (method: string, params: unknown) =>
    codex.connections.at(-1)?.handlers.onNotification?.(method, params)
  const turns = codexTurnLifecycleFake(CODEX_THREAD, () => notify)
  Object.assign(codex.routes, turns.routes)
  const provider = adapterFor(codex, {}, [], {
    onDispatchSettledLate: (settlement) => void restRig?.host.settleLateDispatch(settlement),
    onEvent: (event) => {
      if (event.type === 'ended' && 'cause' in event) {
        void restRig?.host.handleAdapterEvent(event)
      }
    }
  })
  adapter = provider
  const current = await createRestTestRig({ adapter: provider })
  restRig = current
  expect(await current.host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const send = restTestSend('work on this')
  expect(await current.host.send(CALLER, send)).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
  const id = send.envelope.clientOperationId
  const interrupts = () =>
    codex.connections[0]!.calls.filter((call) => call.method === 'turn/interrupt')
  return { current, turns, id, interrupts }
}

it('Codex: reaches a turn that started before the user echo', async () => {
  const { current, turns, id, interrupts } = await admittedCodexSend()
  turns.start()
  await current.host.flushStreamedEvents(SESSION)
  expect(
    (await current.host.journalSnapshot(SESSION)).submissions.find(
      (row) => row.clientMessageId === id
    )
  ).toMatchObject({ providerItemId: null, dispatchState: 'pending' })
  expect(await current.host.cancel(CALLER, unnamedStop())).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(interrupts()).toMatchObject([{ params: { threadId: CODEX_THREAD, turnId: 'turn-1' } }])
})

it('Codex: reaches a turn admitted before its started notification or user echo', async () => {
  const { current, turns, interrupts } = await admittedCodexSend()
  turns.run()
  expect(await current.host.cancel(CALLER, unnamedStop())).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(interrupts()).toMatchObject([{ params: { turnId: 'turn-1' } }])
})

it('Codex: never answers a quiet success while an admitted turn cannot yet take an interrupt', async () => {
  const { current, interrupts } = await admittedCodexSend()
  await current.host.flushStreamedEvents(SESSION)
  const began = Promise.withResolvers<void>()
  openWaits.began = began.resolve
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const stopping = current.host.cancel(CALLER, unnamedStop())
  try {
    await began.promise
    expect(openWaits.turnIds).toEqual(['turn-1'])
    const held = settledWithin(stopping, CODEX_TURN_OPEN_WAIT_MS - 1)
    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS - 1)
    expect(openWaits.ended).toEqual([])
    expect(await held).toBe('held')
    expect(interrupts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(openWaits.ended).toEqual(['turn-1'])
  } finally {
    openWaits.began = null
    openWaits.releaseAll?.()
    vi.useRealTimers()
    await stopping
  }
  const response = await stopping
  expect(interrupts().length).toBeGreaterThan(0)
  const child = current.host.collaboratorsForTests().sessions.get(SESSION)?.child
  if (response.ok) {
    expect(response.value.cancelled).toBe(true)
    expect(child ?? null).toBeNull()
  } else {
    expect(response.refusal.code).toBe('agent_session_operation_unknown')
  }
})

it('Codex: a retried Stop replays and never interrupts a later turn', async () => {
  const { current, turns, interrupts } = await admittedCodexSend()
  turns.start()
  await current.host.flushStreamedEvents(SESSION)
  const stop = unnamedStop()
  expect(await current.host.cancel(CALLER, stop)).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  await vi.waitFor(() => expect(turns.turnId).toBeNull())
  expect(await current.host.send(CALLER, restTestSend('later work'))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(turns.turnId).toBe('turn-2'))
  turns.start()
  await current.host.flushStreamedEvents(SESSION)
  expect(await current.host.cancel(CALLER, stop)).toMatchObject({
    ok: true,
    value: { cancelled: false }
  })
  expect(interrupts()).toHaveLength(1)
  expect(turns.turnId).toBe('turn-2')
})

it('reaches a turn opened before the user echo links it to the send', async () => {
  queuedRig = await createQueuedMessageTestRig()
  await queuedRig.workingSend()
  publishCodexTurnLifecycle({
    sink: queuedRig.providerEvents(),
    primaryThreadId: THREAD,
    sessionId: SESSION,
    threadId: THREAD,
    turnId: 'turn-opening',
    state: 'running'
  })
  await queuedRig.host.flushStreamedEvents(SESSION)
  expect(await queuedRig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(queuedRig.cancelTurn).toHaveBeenCalled()
})

it('stops the waiting send when a later send reaches the host just before the Stop', async () => {
  queuedRig = await createQueuedMessageTestRig({ restartable: true })
  await queuedRig.workingSend()
  const later = queuedRig.send('sent just before Stop')
  expect(await later.result).toMatchObject({ ok: true })
  expect(await queuedRig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(queuedRig.cancelTurn).toHaveBeenCalledOnce()
  expect(await queuedRig.submission(later.id)).toMatchObject({ dispatchState: 'rejected' })
})

it('a Stop after a Stop that failed still tries to stop the waiting send', async () => {
  queuedRig = await createQueuedMessageTestRig({ restartable: true })
  await queuedRig.workingSend()
  queuedRig.cancelTurn.mockImplementationOnce(async () => {
    throw new Error('interrupt timed out')
  })
  queuedRig.closeSession.mockImplementationOnce(async () => {
    throw new Error('exit not proven')
  })
  await queuedRig.host.cancel(QUEUED_RIG_CALLER, unnamedStop())
  expect(queuedRig.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeTruthy()
  const tries = queuedRig.cancelTurn.mock.calls.length + queuedRig.closeSession.mock.calls.length
  await queuedRig.host.cancel(QUEUED_RIG_CALLER, unnamedStop())
  expect(
    queuedRig.cancelTurn.mock.calls.length + queuedRig.closeSession.mock.calls.length
  ).toBeGreaterThan(tries)
})
