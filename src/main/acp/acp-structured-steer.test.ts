import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { DISPATCH_REJECTED_CANCELLED } from '../../shared/structured-agent-session-dispatch-rejection'
import {
  closeProviderTimelineRigs,
  SESSION as ADAPTER_SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  prepareMailPerformanceHistory,
  measureMailDeliveryWork
} from './acp-mail-performance.test-support'
import type { AcpScriptedAgent, FakeFrame } from './acp-scripted-agent.test-support'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk,
  sendHello,
  waitFor
} from './acp-structured-adapter.test-support'
import {
  framesOf,
  message,
  openAttachedHostRig,
  promptIdOf,
  send,
  stop
} from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const GROK_TURN = 'task-completed-background-1'

function endsGrokTurn(agent: AcpScriptedAgent): void {
  agent.notify('x.ai/session_notification', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'turn_completed', prompt_id: GROK_TURN, stop_reason: 'cancelled' }
  })
}

function answersCancels(agent: AcpScriptedAgent): void {
  agent.on('session/cancel', () => {
    const answered = new Set(agent.frames.flatMap((frame) => (frame.method ? [] : [frame.id])))
    const running = agent.frames.findLast(
      (frame): frame is FakeFrame => frame.method === 'session/prompt' && !answered.has(frame.id)
    )
    if (running) {
      agent.reply(running, { stopReason: 'cancelled' })
    }
  })
}

describe('a send while a Grok prompt runs', () => {
  it('cancels the running prompt, then sends as the next one', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'first')
    const first = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:first', 'working'))
    await rig.settle()
    await sendHello(rig, 'steer')
    await rig.settle()
    expect(rig.sent('session/cancel')).toHaveLength(1)
    expect(rig.sent('session/prompt')).toHaveLength(1)
    rig.child().agent.reply(first, { stopReason: 'cancelled' })
    const second = await rig.frame('session/prompt', 1)
    expect(promptIdOf(second)).toBe('prompt:steer')
    rig.child().agent.notify('session/update', replyChunk('prompt:steer', 'on it'))
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.map((turn) => turn.state)).toEqual(['interrupted', 'running'])
    })
    // A cancel, not a Stop: the session stays.
    expect(rig.child().closes).toBe(0)
  })

  it('runs the last of two quick steers; the one between is sent and cancelled', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'first')
    await rig.frame('session/prompt')
    await rig.settle()
    await sendHello(rig, 'steer-1')
    await sendHello(rig, 'steer-2')
    await rig.settle()
    // One cancel per running prompt, however many steers wait behind it.
    expect(rig.sent('session/cancel')).toHaveLength(1)
    answersCancels(rig.child().agent)
    rig.child().agent.reply(rig.sent('session/prompt')[0]!, { stopReason: 'cancelled' })
    await rig.frame('session/prompt', 2)
    await rig.settle()
    expect(rig.sent('session/prompt').map(promptIdOf)).toEqual([
      'prompt:first',
      'prompt:steer-1',
      'prompt:steer-2'
    ])
    expect(rig.sent('session/cancel')).toHaveLength(2)
    expect(rig.settled.map((settled) => settled.clientMessageId)).toEqual(['first', 'steer-1'])
  })

  it('asks again on the next steer when the first cancel was never written', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'first')
    await rig.frame('session/prompt')
    await rig.settle()
    const child = rig.child()
    const cancel = child.cancel.bind(child)
    let failNext = true
    child.cancel = (options) => {
      if (failNext) {
        failNext = false
        return Promise.reject(new Error('write failed'))
      }
      return cancel(options)
    }
    await sendHello(rig, 'steer-1')
    await rig.settle()
    expect(rig.sent('session/cancel')).toHaveLength(0)
    await sendHello(rig, 'steer-2')
    await sendHello(rig, 'steer-3')
    await rig.settle()
    // The failed write freed the running prompt's one cancel; the next steer used it.
    expect(rig.sent('session/cancel')).toHaveLength(1)
  })

  it('withdraws a steer a Stop reaches before its cancel lands', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'first')
    const first = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:first', 'working'))
    await rig.settle()
    await sendHello(rig, 'steer')
    await expect(rig.adapter.cancelTurn({ sessionId: ADAPTER_SESSION, fence: 1 })).resolves.toEqual(
      {
        cancelled: true
      }
    )
    rig.child().agent.reply(first, { stopReason: 'cancelled' })
    await rig.settle()
    expect(rig.sent('session/prompt')).toHaveLength(1)
    expect(rig.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'steer', state: 'rejected' })
      ])
    )
  })

  it('waits as long as Grok takes to answer a steer cancel, and a Stop then still ends it', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'first')
    await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:first', 'working'))
    await rig.settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      await sendHello(rig, 'steer')
      await rig.settle()
      await vi.advanceTimersByTimeAsync(60_000)
      await rig.settle()
      expect(rig.sent('session/cancel')).toHaveLength(1)
      expect(rig.ended).toEqual([])
      expect(rig.child().closes).toBe(0)
      expect(rig.settled.map((settled) => settled.clientMessageId)).toEqual(['first'])
      await rig.adapter.cancelTurn({ sessionId: ADAPTER_SESSION, fence: 1 })
      await rig.settle()
      expect(rig.sent('session/cancel')).toHaveLength(2)
      expect(rig.settled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ clientMessageId: 'steer', state: 'rejected' })
        ])
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a send while a turn Grok began itself runs', () => {
  it('goes to Grok at once, with no cancel of that turn', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const { agent } = rig.child()
    agent.notify('session/update', replyChunk(GROK_TURN, 'Build finished; now'))
    await rig.settle()
    await sendHello(rig, 'during')
    const prompt = await rig.frame('session/prompt')
    expect(rig.sent('session/cancel')).toHaveLength(0)
    agent.notify('x.ai/session_notification', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'turn_completed', prompt_id: GROK_TURN, stop_reason: 'end_turn' }
    })
    agent.notify('session/update', replyChunk(promptIdOf(prompt), 'on it'))
    agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    expect(rig.settled).toEqual([
      expect.objectContaining({ clientMessageId: 'during', providerIdentity: expect.anything() })
    ])
    const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    expect(turns.map((turn) => turn.state)).toEqual(['completed', 'completed'])
  })

  it("cuts Grok's turn on a second send and runs both messages, never ending Grok", async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const { agent } = rig.child()
    agent.notify('session/update', replyChunk(GROK_TURN, 'Build finished; now'))
    await rig.settle()
    await sendHello(rig, 'a')
    const a = await rig.frame('session/prompt')
    // Grok queues `a` behind its own turn; a cancel ends only the running turn and promotes `a`.
    agent.on('session/cancel', () => {
      endsGrokTurn(agent)
      agent.notify('session/update', replyChunk(promptIdOf(a), 'working on a'))
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      await sendHello(rig, 'b')
      await rig.settle()
      expect(rig.sent('session/cancel')).toHaveLength(1)
      // `a` runs a whole turn: a steer's cancel never ends Grok.
      await vi.advanceTimersByTimeAsync(60_000)
      await rig.settle()
      expect(rig.ended).toEqual([])
      expect(rig.child().closes).toBe(0)
      agent.reply(a, { stopReason: 'end_turn' })
      await rig.settle()
      const b = rig.sent('session/prompt')[1]
      if (!b) {
        throw new Error('Missing prompt for b after a completed')
      }
      expect(promptIdOf(b)).toBe('prompt:b')
      agent.notify('session/update', replyChunk('prompt:b', 'on b'))
      agent.reply(b, { stopReason: 'end_turn' })
      await rig.settle()
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.map((turn) => turn.state)).toEqual(['interrupted', 'completed', 'completed'])
      expect(rig.settled.map((settled) => settled.clientMessageId)).toEqual(['a', 'b'])
      expect(rig.child().closes).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Steer on a Grok card, through the host', () => {
  async function queueCard(rig: Awaited<ReturnType<typeof openAttachedHostRig>>) {
    const { host } = rig
    await host.flushStreamedEvents(SESSION)
    const body = message('and then this')
    const delivery = 'queue-if-active' as const
    const queued = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body, delivery }),
      body,
      delivery,
      userSend: true
    })
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued card')
    }
    const cardId = queued.value.queued.messageId
    const sendNow = () =>
      host.queuedMessageSend(CALLER, {
        envelope: envelope('agentSession.queuedMessageSend', { messageId: cardId }),
        messageId: cardId
      })
    const page = async () => {
      await host.flushStreamedEvents(SESSION)
      const history = await host.history({ sessionId: SESSION, direction: 'tail' })
      return history.ok ? history.page : null
    }
    const sends = async () =>
      (await host.journalSnapshot(SESSION)).submissions
        .filter((entry) => entry.queuedMessageId === cardId)
        .map((entry) => ({ state: entry.dispatchState, reason: entry.reason }))
    return { cardId, sendNow, page, sends }
  }

  async function cardBehindARunningTurn() {
    const rig = await openAttachedHostRig({ stopGraceMs: 20 })
    await send(rig.host, 'hello')
    const prompt = await rig.rig.frame('session/prompt')
    rig.rig.child().agent.notify('session/update', replyChunk(promptIdOf(prompt), 'working'))
    await rig.rig.settle()
    return { ...rig, prompt, ...(await queueCard(rig)) }
  }

  it('leaves the card in the host queue while the turn runs, and cancels then sends it on Steer', async () => {
    const { rig, host, prompt, sendNow, page, sends } = await cardBehindARunningTurn()
    const { agent } = rig.child()
    await rig.settle()
    // Queued, not sent: nothing reaches Grok and the card stays editable.
    expect((await page())?.queuedMessages?.map((card) => card.state)).toEqual(['waiting'])
    expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(1)
    expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)

    expect(await sendNow()).toMatchObject({ ok: true })
    await waitFor(() => expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(1))
    expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(1)
    agent.reply(prompt, { stopReason: 'cancelled' })
    const steered = await rig.frame('session/prompt', 1)
    agent.notify('session/update', replyChunk(promptIdOf(steered), 'on it'))
    await waitFor(async () => expect(await sends()).toMatchObject([{ state: 'accepted' }]))
    expect((await page())?.queuedMessages ?? []).toEqual([])
    expect(rig.child().exited).toBe(false)
    await host.close(SESSION, 'user-close')
  })

  it("steers an older client's send the same way", async () => {
    const rig = await openAttachedHostRig()
    const { agent } = rig.rig.child()
    await send(rig.host, 'hello')
    const prompt = await rig.rig.frame('session/prompt')
    agent.notify('session/update', replyChunk(promptIdOf(prompt), 'working'))
    await rig.rig.settle()
    await rig.host.flushStreamedEvents(SESSION)
    await send(rig.host, 'steer')
    await waitFor(() => expect(framesOf(rig.rig.child(), 'session/cancel')).toHaveLength(1))
    agent.reply(prompt, { stopReason: 'cancelled' })
    await rig.rig.frame('session/prompt', 1)
    answersCancels(agent)
    await rig.host.close(SESSION, 'user-close')
  })

  it('brings the card back paused when a Stop reaches it before the cancel lands', async () => {
    const { rig, host, sendNow, page, sends } = await cardBehindARunningTurn()
    expect(await sendNow()).toMatchObject({ ok: true })
    await waitFor(() => expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(1))
    const first = rig.child()
    expect(await stop(host)).toMatchObject({ ok: true, value: { cancelled: true } })
    await waitFor(() => expect(first.exited).toBe(true))
    expect(framesOf(first, 'session/prompt')).toHaveLength(1)
    await waitFor(async () => {
      const current = await page()
      expect({
        pause: current?.queuePause ?? null,
        cards: (current?.queuedMessages ?? []).map((card) => card.state),
        sends: await sends()
      }).toEqual({
        pause: { reason: 'stopped' },
        cards: ['waiting'],
        sends: [{ state: 'rejected', reason: DISPATCH_REJECTED_CANCELLED }]
      })
    })
    await host.close(SESSION, 'user-close')
  })

  it('sends the card at once on Steer during a turn Grok began itself, with no cancel', async () => {
    const rig = await openAttachedHostRig({ stopGraceMs: 20 })
    const child = rig.rig.child()
    child.agent.notify('session/update', replyChunk(GROK_TURN, 'Build finished; now'))
    await rig.rig.settle()
    const { sendNow, sends } = await queueCard(rig)
    expect(await sendNow()).toMatchObject({ ok: true })
    const steered = await rig.rig.frame('session/prompt')
    expect(framesOf(child, 'session/cancel')).toHaveLength(0)
    endsGrokTurn(child.agent)
    child.agent.notify('session/update', replyChunk(promptIdOf(steered), 'on it'))
    await waitFor(async () => expect(await sends()).toMatchObject([{ state: 'accepted' }]))
    expect(framesOf(child, 'session/cancel')).toHaveLength(0)
    expect(child.exited).toBe(false)
    await rig.host.close(SESSION, 'user-close')
  })
})

// A real execution host, ACP adapter and RPC dispatcher; only the ACP child is scripted.
it.each(['fresh', 'mixed', 'mixed-10N', 'invalidation', 'held-epoch'] as const)(
  'drains five mail obligations as one ACP input (%s), with exact check replay and ack',
  async (variant) => {
    const history = variant === 'mixed-10N' ? 'mixed' : variant
    const population = variant === 'mixed-10N' ? 1000 : 100
    const { OrchestrationDb } = await import('../runtime/orchestration/db')
    const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
    const { RpcDispatcher } = await import('../runtime/rpc/dispatcher')
    const { ORCHESTRATION_METHODS } = await import('../runtime/rpc/methods/orchestration')
    const { ORCHESTRATION_CONTRACT_VERSION } = await import('../../shared/protocol-version')
    const { idOf, resultOf } =
      await import('../runtime/rpc/orchestration-session-caller-test-fixture')
    const { setStructuredAgentSessionHost } =
      await import('../native-chat/agent-session-wire/structured-agent-session-registry')
    const { createStructuredMailboxPointerHost } =
      await import('../runtime/orchestration/structured-mailbox-pointer-host')
    const { OrchestrationStructuredMailboxPointerDelivery } =
      await import('../runtime/orchestration/structured-mailbox-pointer-delivery')
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    const f = await openAttachedHostRig()
    setStructuredAgentSessionHost(f.host)
    const rpc = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    let request = 0
    const call = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await rpc.dispatch({
        id: String(++request),
        method,
        params,
        authToken: 'test',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: `backlog-${request}`,
        orchestrationCompatibilityEvidence: { agentSessionId: SESSION }
      })
      expect(response).toMatchObject({ ok: true })
      return resultOf(response)
    }
    try {
      const runId = idOf((await call('orchestration.runCreate', { objective: 'backlog' })).run)
      const mailbox = `run:${runId}`
      const performance =
        history === 'mixed'
          ? prepareMailPerformanceHistory(db, mailbox, runId, population)
          : undefined
      const pointerHost = createStructuredMailboxPointerHost()
      const delivery = new OrchestrationStructuredMailboxPointerDelivery({
        getDb: () => db,
        getMessageWaiters: () => performance?.waiters,
        resolveStructuredTarget: () => ({ sessionId: SESSION, dispatchId: null }),
        getCliCommand: () => 'orca',
        senderName: () => null,
        host: pointerHost
      })
      const insert = () =>
        db.insertMessage({ from: 'worker', to: mailbox, runId, subject: 'result' })
      const first = insert()
      let prompts = 0
      if (history === 'mixed' || history === 'invalidation') {
        delivery.deliverForHandle(mailbox)
        const failed = await f.rig.frame('session/prompt')
        f.rig.child().agent.notify('session/update', replyChunk(promptIdOf(failed), 'working'))
        await waitFor(() =>
          expect(JSON.parse(db.getMessageById(first.id)!.handoff!).phase).toBe('offered')
        )
        f.rig.child().agent.fail(failed, -32603, 'Internal error')
        await waitFor(async () =>
          expect((await f.turns())[0]).toMatchObject({ outcome: 'failure' })
        )
        prompts = 1
      } else if (history === 'fresh') {
        await send(f.host, 'working before mail')
        const working = await f.rig.frame('session/prompt')
        f.rig.child().agent.notify('session/update', replyChunk(promptIdOf(working), 'working'))
        await f.rig.settle()
        await f.host.flushStreamedEvents(SESSION)
        answersCancels(f.rig.child().agent)
        prompts = 1
      }
      if (history === 'held-epoch') {
        const held = vi.spyOn(pointerHost, 'send').mockResolvedValue({ kind: 'held' })
        delivery.deliverForHandle(mailbox)
        await waitFor(() => expect(held).toHaveBeenCalledTimes(1))
        const original = JSON.parse(db.getMessageById(first.id)!.handoff!)
        delivery.onJournalActivity(SESSION)
        await waitFor(() => expect(held).toHaveBeenCalledTimes(2))
        expect(JSON.parse(db.getMessageById(first.id)!.handoff!).operationId).toBe(
          original.operationId
        )
        const journal = f.host.collaboratorsForTests().sessions.get(SESSION)!.journal
        await journal.replaceEpochItems('handle_forked', f.fence(), [])
        expect(journal.cursor().epoch).not.toBe(original.epoch)
        held.mockRestore()
      }
      performance?.restoreParkedCandidates(db.getMessageById(first.id)!.handoff!)
      const messages = [first, ...Array.from({ length: 4 }, insert)]
      let invalidated = false
      const actualSend = f.host.send.bind(f.host)
      const sendSpy = vi.spyOn(f.host, 'send').mockImplementation(async (...args) => {
        if (history === 'invalidation' && !invalidated) {
          invalidated = true
          db.getOrCreateMailboxDelivery({
            runId,
            mailboxHandle: mailbox,
            consumerGeneration: db.getRun(runId)!.consumer_generation,
            limit: 1
          })
        }
        return actualSend(...args)
      })
      delivery.deliverForHandle(mailbox)
      const pointer = await f.rig.frame('session/prompt', prompts).catch((error) => {
        console.error(
          'backlog diagnostic',
          history,
          db.getUnreadMessages(mailbox),
          sendSpy.mock.calls.length
        )
        throw error
      })
      await f.rig.settle()
      expect(f.rig.sent('session/prompt')).toHaveLength(prompts + 1)
      expect(f.rig.sent('session/cancel')).toHaveLength(history === 'fresh' ? 1 : 0)
      expect(JSON.stringify(pointer.params)).toContain(
        `You have ${history === 'invalidation' ? 4 : 5} orchestration messages`
      )
      expect(messages.map((m) => db.getMessageById(m.id)!.recovery_used)).toEqual([
        history === 'mixed' || history === 'invalidation' ? 1 : 0,
        0,
        0,
        0,
        0
      ])
      expect(
        new Set(
          messages
            .slice(history === 'invalidation' ? 1 : 0)
            .map((m) => JSON.parse(db.getMessageById(m.id)!.handoff!).authorizationId)
        ).size
      ).toBe(history === 'invalidation' ? 4 : 5)
      f.rig.child().agent.notify('session/update', replyChunk(promptIdOf(pointer), 'checking'))
      await waitFor(() =>
        expect(JSON.parse(db.getMessageById(messages.at(-1)!.id)!.handoff!).phase).toBe('offered')
      )
      if (performance) {
        await measureMailDeliveryWork({ f, db, delivery, mailbox, performance })
        expect(f.rig.sent('session/prompt')).toHaveLength(prompts + 1)
        expect(f.rig.sent('session/cancel')).toHaveLength(0)
        expect(messages.map((row) => db.getMessageById(row.id)!.recovery_used)).toEqual([
          1, 0, 0, 0, 0
        ])
        performance.finish()
      }
      const fetched = await call('orchestration.check')
      if (performance) {
        expect(fetched.messages).toMatchObject(messages.map((row) => ({ id: row.id })))
      }
      const replay = await call('orchestration.check')
      expect(replay).toMatchObject({
        deliveryId: fetched.deliveryId,
        replayed: true,
        messages: fetched.messages
      })
      const next = await call('orchestration.check', { ack: fetched.deliveryId })
      if (history === 'invalidation') {
        expect(next).toMatchObject({ count: 4 })
        expect(await call('orchestration.check', { ack: next.deliveryId })).toMatchObject({
          count: 0
        })
      } else {
        expect(next).toMatchObject({ count: 0 })
      }
      f.rig.child().agent.reply(pointer, { stopReason: 'end_turn' })
      await waitFor(async () =>
        expect(
          (await f.host.journalSnapshot(SESSION)).items
            .flatMap((item) => readAgentJournalTurn(item.body) ?? [])
            .at(-1)
        ).toMatchObject({ state: 'completed' })
      )
      delivery.onJournalActivity(SESSION)
      await f.rig.settle()
      expect(db.getUnreadMessages(mailbox)).toHaveLength(0)
      expect(f.rig.sent('session/prompt')).toHaveLength(prompts + 1)
      expect(sendSpy.mock.calls.length).toBe(history === 'invalidation' ? 2 : 1)
    } finally {
      setStructuredAgentSessionHost(null)
      vi.restoreAllMocks()
      db.close()
    }
  }
)
