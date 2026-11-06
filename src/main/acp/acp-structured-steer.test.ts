import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { DISPATCH_REJECTED_CANCELLED } from '../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import {
  closeProviderTimelineRigs,
  SESSION as ADAPTER_SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionAdmitFreshInput } from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import type { AcpScriptedAgent, FakeFrame } from './acp-scripted-agent.test-support'
import { awaitAcpTurnEnd } from './acp-structured-stop'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { isAcpReadySession } from './acp-structured-child'
import {
  GROK,
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

// OMP: the model option refuses a role, and its own /model resolves it (builtin-modes.ts).
async function openRoleRig(
  hold: { holdOption?: boolean; holdCommand?: boolean; commandReply?: string } = {}
) {
  const spec = { ...GROK, dialect: { ...GROK.dialect, modelCommand: OMP_ACP_DIALECT.modelCommand } }
  const held = { option: () => {}, command: () => {} }
  const rig = await openAcpAdapterRig({
    spec,
    script: (agent) => {
      agent.on('session/set_config_option', (frame) => {
        const refuse = () =>
          agent.fail(frame, -32603, 'Internal error', { details: 'Unknown ACP model: @worker_be' })
        if (hold.holdOption) {
          held.option = refuse
        } else {
          refuse()
        }
      })
      agent.on('session/prompt', (frame) => {
        if (!JSON.stringify(frame.params).includes('/model @worker_be')) {
          return
        }
        const answer = () => {
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: hold.commandReply ?? 'Model set to grok-4.6.' }
            }
          })
          agent.reply(frame, { stopReason: 'end_turn' })
        }
        if (hold.holdCommand) {
          held.command = answer
        } else {
          answer()
        }
      })
    }
  })
  await rig.acquire()
  return { rig, release: { option: () => held.option(), command: () => held.command() } }
}

type AdapterRig = Awaited<ReturnType<typeof openAcpAdapterRig>>

function sendRole(
  rig: AdapterRig,
  clientMessageId: string,
  admitFreshInput?: StructuredAgentSessionAdmitFreshInput
) {
  return rig.adapter.dispatch({
    sessionId: ADAPTER_SESSION,
    clientMessageId,
    body: message('hello'),
    fence: 1,
    executionOptions: { model: '@worker_be' },
    ...(admitFreshInput ? { admitFreshInput } : {})
  })
}

function promptsSent(rig: AdapterRig): string[] {
  return rig
    .sent('session/prompt')
    .map((frame) =>
      JSON.stringify(frame.params).includes('/model @worker_be') ? 'command' : promptIdOf(frame)
    )
}

describe('permission changes with already admitted ACP input', () => {
  it('releases deadline and abort waiters without disturbing the active input', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'still running')
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk(promptIdOf(prompt), 'working'))
    await rig.settle()
    const session = rig.adapter['children'].sessions.get(ADAPTER_SESSION)
    if (!isAcpReadySession(session)) {
      throw new Error('ACP session did not become ready')
    }
    for (const population of [1, 10]) {
      for (let index = 0; index < population; index++) {
        await awaitAcpTurnEnd(session, Date.now(), 0)
      }
      expect(session.turns['idleWaiters'].size).toBe(0)
      expect(session.lane['turnWatchers'].size).toBe(0)
    }
    const abort = new AbortController()
    const reason = new Error('caller stopped waiting')
    const aborted = expect(awaitAcpTurnEnd(session, Date.now(), 10_000, abort.signal)).rejects.toBe(
      reason
    )
    abort.abort(reason)
    await aborted
    expect(session.turns['idleWaiters'].size).toBe(0)
    expect(session.lane['turnWatchers'].size).toBe(0)
    const successor = awaitAcpTurnEnd(session, Date.now(), 500)
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await successor
    expect(session.turns.running).toBe(false)
    expect(session.lane.openTurnId).toBeNull()
  })

  it('settles a provider-initiated turn and delivers the new-policy input once', async () => {
    const { host, rig } = await openAttachedHostRig()
    const original = rig.child()
    original.agent.notify('session/update', replyChunk(GROK_TURN, 'background task finished'))
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    original.agent.on('session/cancel', () => endsGrokTurn(original.agent))
    const fields = { key: 'permissionMode', value: 'full-access' }
    expect(
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', fields),
        ...fields
      })
    ).toMatchObject({ ok: true })
    const id = await send(host, 'new policy')
    await waitFor(() => expect(original.exited).toBe(true))
    expect(framesOf(original, 'session/cancel')).toHaveLength(1)
    expect(framesOf(original, 'session/prompt')).toHaveLength(0)
    const prompt = await rig.frame('session/prompt')
    expect(promptIdOf(prompt)).toBe(`prompt:${id}`)
    rig.child().agent.notify('session/update', replyChunk(promptIdOf(prompt), 'done'))
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await waitFor(() => expect(journal.submission(id)?.dispatchState).toBe('accepted'))
    expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(1)
    await host.close(SESSION, 'user-close')
  })

  it.each(['drained', 'deadline'] as const)(
    'preserves the earlier steer when the transition is %s',
    async (outcome) => {
      const fixture = await openAttachedHostRig({ stopGraceMs: outcome === 'deadline' ? 30 : 500 })
      const { host, rig } = fixture
      const original = rig.child()
      const a = await send(host, 'A running')
      const promptA = await rig.frame('session/prompt')
      original.agent.notify('session/update', replyChunk(promptIdOf(promptA), 'working A'))
      await rig.settle()
      await host.flushStreamedEvents(SESSION)
      const b = await send(host, 'B already admitted')
      await waitFor(() => expect(framesOf(original, 'session/cancel')).toHaveLength(1))
      const fields = { key: 'permissionMode', value: 'full-access' }
      expect(
        await host.setOption(CALLER, {
          envelope: envelope('agentSession.setOption', fields),
          ...fields
        })
      ).toMatchObject({ ok: true })
      const c = await send(host, 'C new policy')
      const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
      if (outcome === 'deadline') {
        await waitFor(() => expect(journal.submission(c)?.dispatchState).toBe('rejected'))
        expect(journal.submission(c)?.rejection).toMatchObject({
          kind: 'restartFailed',
          neverReachedAgent: true
        })
        expect(journal.submission(b)?.dispatchState).toBe('pending')
        expect(original.exited).toBe(false)
      }
      original.agent.reply(promptA, { stopReason: 'cancelled' })
      const promptB = await rig.frame('session/prompt', 1)
      expect(promptIdOf(promptB)).toBe(`prompt:${b}`)
      original.agent.notify('session/update', replyChunk(promptIdOf(promptB), 'answered B'))
      original.agent.reply(promptB, { stopReason: 'end_turn' })
      await waitFor(() => expect(journal.submission(b)?.dispatchState).toBe('accepted'))
      expect(journal.submission(a)?.dispatchState).toBe('accepted')
      expect(framesOf(original, 'session/prompt')).toHaveLength(2)
      if (outcome === 'drained') {
        await waitFor(() => expect(original.exited).toBe(true))
        const promptC = await rig.frame('session/prompt')
        expect(promptIdOf(promptC)).toBe(`prompt:${c}`)
        rig.child().agent.notify('session/update', replyChunk(promptIdOf(promptC), 'answered C'))
        rig.child().agent.reply(promptC, { stopReason: 'end_turn' })
        await waitFor(() => expect(journal.submission(c)?.dispatchState).toBe('accepted'))
      } else {
        expect(journal.submission(c)?.dispatchState).toBe('rejected')
      }
      await host.close(SESSION, 'user-close')
    }
  )
})

describe('a send while a Grok prompt runs', () => {
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

  it('runs a role steer the model option refuses in its place: the steer ahead is cancelled first', async () => {
    const { rig } = await openRoleRig()
    await sendHello(rig, 'first')
    await rig.frame('session/prompt')
    await rig.settle()
    await sendHello(rig, 'steer-1')
    const role = sendRole(rig, 'steer-2')
    await rig.settle()
    answersCancels(rig.child().agent)
    rig.child().agent.reply(rig.sent('session/prompt')[0]!, { stopReason: 'cancelled' })
    await expect(role).resolves.toEqual({ state: 'admitted' })
    await rig.frame('session/prompt', 3)
    expect(promptsSent(rig)).toEqual([
      'prompt:first',
      'prompt:steer-1',
      'command',
      'prompt:steer-2'
    ])
    // steer-1 started and was cancelled for the newer steer, never left to answer in full.
    expect(rig.sent('session/cancel')).toHaveLength(2)
  })

  // No abort signal in these: the withdrawal itself must notice the Stop.
  it.each(['while it waits', 'while its model option is answered'] as const)(
    'sends nothing more for a role steer that a Stop reaches %s',
    async (when) => {
      const { rig, release } = await openRoleRig({ holdOption: when !== 'while it waits' })
      await sendHello(rig, 'first')
      const first = await rig.frame('session/prompt')
      await rig.settle()
      const role = sendRole(rig, 'role').catch((error: unknown) => error)
      await rig.settle()
      await rig.adapter.cancelTurn({ sessionId: ADAPTER_SESSION, fence: 1 })
      rig.child().agent.reply(first, { stopReason: 'cancelled' })
      await rig.settle()
      // Refused only after the turn ahead ended: no wait is left to notice the Stop.
      release.option()
      expect(await role).toMatchObject({
        rejection: { kind: 'cancelled', neverReachedAgent: true }
      })
      expect(promptsSent(rig)).toEqual(['prompt:first'])
      // A Stop covers only what it reached; the next message goes out.
      await expect(sendHello(rig, 'later')).resolves.toEqual({ state: 'admitted' })
      await rig.frame('session/prompt', 1)
    }
  )

  it.each([
    ['its model command runs', 'Model set to grok-4.6.'],
    // OMP's own refusal after the Stop must not be worded as the model's failure.
    ['its model command runs', 'Failed to set model: prompt rebuild failed'],
    ['it waits to be admitted', 'Model set to grok-4.6.']
  ] as const)(
    'withdraws a role steer a Stop reaches while %s (%s), with no turn running',
    async (when, commandReply) => {
      const admitted = Promise.withResolvers<void>()
      const holdCommand = when === 'its model command runs'
      const { rig, release } = await openRoleRig({ holdCommand, commandReply })
      const role = sendRole(rig, 'role', async (enqueue) => {
        await admitted.promise
        return enqueue('own', false)
      })
      await rig.frame('session/prompt')
      await rig.settle()
      await expect(
        rig.adapter.cancelTurn({ sessionId: ADAPTER_SESSION, fence: 1 })
      ).resolves.toEqual({ cancelled: true })
      release.command()
      admitted.resolve()
      await expect(role).rejects.toMatchObject({
        rejection: { kind: 'cancelled', neverReachedAgent: true }
      })
      expect(promptsSent(rig)).toEqual(['command'])
    }
  )

  it('refuses a Stop with no turn running while an idle role send waits on its model option', async () => {
    // Before the fallback this is an ordinary send: with nothing to stop, Stop is refused, not
    // accepted and ignored. The host's Stop aborts the send's signal instead
    // (acp-structured-host-option-hang.test.ts).
    const { rig, release } = await openRoleRig({ holdOption: true })
    const role = sendRole(rig, 'role')
    await waitFor(() => expect(rig.sent('session/set_config_option')).toHaveLength(1))
    await expect(rig.adapter.cancelTurn({ sessionId: ADAPTER_SESSION, fence: 1 })).resolves.toEqual(
      {
        cancelled: false,
        refusal: { turnNotRunning: true }
      }
    )
    release.option()
    await expect(role).resolves.toEqual({ state: 'admitted' })
    await rig.frame('session/prompt', 1)
    expect(promptsSent(rig)).toEqual(['command', 'prompt:role'])
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
