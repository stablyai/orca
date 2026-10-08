// A message sent while a Grok prompt runs steers: the running prompt is cancelled (the session
// stays) and the message goes as the next prompt. The adapter holds a steer only while that cancel
// lands; the host's queue holds everything else.

import { afterEach, describe, expect, it } from 'vitest'
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

/** A turn Grok began itself, as a background task's completion wakes it. */
const GROK_TURN = 'task-completed-background-1'

function endsGrokTurn(agent: AcpScriptedAgent): void {
  agent.notify('x.ai/session_notification', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'turn_completed', prompt_id: GROK_TURN, stop_reason: 'cancelled' }
  })
}

/** Grok answers each cancel by ending the prompt it is running, as `cancelled`. */
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
    await sendHello(rig, 'steer')
    await new Promise((resolve) => setTimeout(resolve, 120))
    await rig.settle()
    expect(rig.sent('session/cancel')).toHaveLength(1)
    expect(rig.lifecycle).toEqual([])
    expect(rig.child().closes).toBe(0)
    expect(rig.settled.map((settled) => settled.clientMessageId)).toEqual(['first'])
    // A Stop sends its own cancel; the host's grace, not the cancel, ends Grok.
    await rig.adapter.cancelTurn({ sessionId: ADAPTER_SESSION, fence: 1 })
    expect(rig.sent('session/cancel')).toHaveLength(2)
    expect(rig.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'steer', state: 'rejected' })
      ])
    )
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
    await sendHello(rig, 'b')
    await rig.settle()
    expect(rig.sent('session/cancel')).toHaveLength(1)
    // `a` runs a whole turn: a steer's cancel never ends Grok.
    await new Promise((resolve) => setTimeout(resolve, 120))
    await rig.settle()
    expect(rig.lifecycle).toEqual([])
    expect(rig.child().closes).toBe(0)
    agent.reply(a, { stopReason: 'end_turn' })
    const b = await rig.frame('session/prompt', 1)
    expect(promptIdOf(b)).toBe('prompt:b')
    agent.notify('session/update', replyChunk('prompt:b', 'on b'))
    agent.reply(b, { stopReason: 'end_turn' })
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.map((turn) => turn.state)).toEqual(['interrupted', 'completed', 'completed'])
    })
    expect(rig.settled.map((settled) => settled.clientMessageId)).toEqual(['a', 'b'])
    expect(rig.child().closes).toBe(0)
  })
})

describe('Steer on a Grok card, through the host', () => {
  /** A card queued behind whatever turn runs. */
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

  /** A Grok turn running, and a card queued behind it. */
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
    // No queued-message delivery: the host hands it over while the turn runs.
    await send(rig.host, 'steer')
    await waitFor(() => expect(framesOf(rig.rig.child(), 'session/cancel')).toHaveLength(1))
    agent.reply(prompt, { stopReason: 'cancelled' })
    await rig.rig.frame('session/prompt', 1)
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
