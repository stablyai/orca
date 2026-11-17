import { afterEach, expect, it, vi } from 'vitest'
import { readTestJournalSnapshot } from '../../../agent-session-journal/journal-observation.test-support'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { AgentChildWorkView } from '../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { reportedChildWork } from './structured-agent-session-host.test-fixture'
import { appendRewindUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'
import { weekly } from './structured-agent-session-usage-limit-fleet.test-fixture'
import type { UsageLimitAccountScope } from '../../recovery/structured-agent-session-usage-limit-account-hold'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW
} from './structured-agent-session-host-test-data.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

const MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'agent:coordinator', terminalHandle: null, orcaSessionId: null },
      name: null
    }
  ],
  orchestration: { message: 'mail-notice', mailbox: 'agent:worker', dispatchId: null, messages: [] }
}

/** A chat whose agent runs on account A; `switchTo` changes what its next start would use. */
async function chatOnAccountA() {
  let clock = HOST_TEST_NOW
  let home = '/homes/a'
  let openDispatch = false
  // Every account has room from the latest reading on.
  const room: UsageLimitAccountScope = {
    scope: 'any',
    account: { key: 'any', read: () => weekly(0, null, clock), refresh: () => true }
  }
  const current = await createQueuedMessageTestRig({
    now: () => clock,
    restartable: true,
    acquiredAccountHome: () => ({ variable: 'CODEX_HOME', path: home }),
    usageLimitAutoContinue: {
      isEnabled: () => true,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {},
      accountUsage: async () => room
    }
  })
  rig = current
  let accountReads = 0
  let onAccountRead: { at: number; run: () => void } | undefined
  current.host.deps.launchAccountHome = async () => {
    accountReads++
    if (onAccountRead?.at === accountReads) {
      const { run } = onAccountRead
      onAccountRead = undefined
      run()
    }
    return { variable: 'CODEX_HOME', path: home }
  }
  let dispatchReads = 0
  current.host.deps.hasOpenDispatch = () => {
    dispatchReads++
    return openDispatch
  }
  // What the runtime fires when a Dispatch settles or the account selection changes.
  const releases = new Set<(edge: 'dispatch' | 'account') => void>()
  current.host.deps.accountMoveWakes = {
    subscribe: (wake) => {
      releases.add(wake)
      return () => releases.delete(wake)
    },
    selection: () => [home],
    openDispatches: (records) => {
      dispatchReads++
      return new Set(openDispatch ? records.map((record) => record.sessionId) : [])
    }
  }
  await eventually(() =>
    expect(current.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
  )
  const child = () => current.host.collaboratorsForTests().sessions.get(SESSION)?.child
  const accountA = child()!.fence
  return {
    accountA,
    child,
    /** The agent's last turn hit a usage limit that resets a minute from now. */
    limited: async () => {
      await current.store.setSessionTabVisibility(SESSION, true)
      return appendRewindUsageLimitedTurn(
        current.host.collaboratorsForTests().sessions.get(SESSION)!.journal,
        clock
      )
    },
    nextQueued: async () => {
      const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
      return page.ok ? (page.page.nextQueuedMessageId ?? null) : 'refused'
    },
    hostSends: async () =>
      (
        await readTestJournalSnapshot(
          current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
        )
      ).submissions.filter((submission) => submission.origin === 'host'),
    /** One automatic-continue pass, `ms` later. */
    sweep: async (ms: number) => {
      clock += ms
      await current.host.usageLimitContinue.tick()
    },
    /** The selection changes: what a start would use, and the edge settings fire for it. */
    switchTo: (path: string) => {
      home = path
      releases.forEach((wake) => wake('account'))
    },
    /** The selection changes with no edge, as when a removed account is pruned from it. */
    switchSilentlyTo: (path: string) => {
      home = path
    },
    /** The Dispatch settles in the orchestration store, with no write to this chat. */
    closeDispatch: () => {
      openDispatch = false
      releases.forEach((wake) => wake('dispatch'))
    },
    accountReads: () => accountReads,
    dispatchReads: () => dispatchReads,
    /** Runs once, inside the handover's read of the account a start would use: the read after
     *  the send's admission. */
    onHandoverAccountRead: (run: () => void) => {
      onAccountRead = { at: accountReads + 2, run }
    },
    /** Orchestration changes that touch no Dispatch of this chat. */
    unrelatedDispatchChanges: (count: number) => {
      for (let i = 0; i < count; i++) {
        releases.forEach((wake) => wake('dispatch'))
      }
    },
    setOpenDispatch: (open: boolean) => {
      openDispatch = open
    },
    background: (views: AgentChildWorkView[]) => {
      clock += 1_000
      current.host.publishChildWorkEvidence(SESSION, reportedChildWork(views, clock))
    },
    /** Every dispatch of `text`, by the fence of the child that took it. */
    dispatchedTo: (text: string) =>
      current.dispatch.mock.calls
        .filter(([input]) => JSON.stringify(input.body.blocks).includes(text))
        .map(([input]) => input.fence),
    /** Every mail dispatch, by fence: the agent is sent a pointer, not the mail's words. */
    mailDispatchedTo: () =>
      current.dispatch.mock.calls
        .filter(([input]) => input.body.from?.orchestration?.message === 'mail-notice')
        .map(([input]) => input.fence)
  }
}

function devServer(overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id: 'child-dev',
    providerId: 'task-dev',
    kind: 'command',
    description: 'npm run dev',
    state: 'working',
    membership: 'live',
    firstObservedAt: HOST_TEST_NOW,
    observedAt: HOST_TEST_NOW,
    stoppable: true,
    invocation: { invocationId: 'spawn-dev', generation: 1 },
    ...overrides
  }
}

it('holds a send behind a background command, then delivers it once on the new account', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  const sent = rig!.send('next step')
  expect(await sent.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: sent.id, state: 'waiting' }])
  )
  expect(chat.dispatchedTo('next step')).toEqual([])
  // The queue names no card it will not send, so the chat does not read as working.
  expect(await chat.nextQueued()).toBeNull()

  chat.background([devServer({ membership: 'settled', state: 'done', outcome: 'succeeded' })])

  await eventually(async () => expect((await rig!.handoff(sent.id))?.handedOverAt).toBeDefined())
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
  expect(chat.dispatchedTo('next step')).toEqual([chat.child()!.fence])
  expect(chat.child()!.fence).not.toBe(chat.accountA)
  expect(rig!.starts).toHaveBeenCalledTimes(2)
})

it("lets a worker's mail reach its open dispatch past a held send, then moves accounts", async () => {
  const chat = await chatOnAccountA()
  chat.setOpenDispatch(true)
  chat.switchTo('/homes/b')
  const person = rig!.send('a new task for you')
  await person.result
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: person.id, state: 'waiting' }])
  )

  const mail = rig!.send('coordinator reply', undefined, { internal: true, from: MAIL })
  await mail.result
  // The reply the dispatch waits on goes to the agent still holding it, on A.
  await eventually(() => expect(chat.mailDispatchedTo()).toEqual([chat.accountA]))
  expect(chat.dispatchedTo('a new task for you')).toEqual([])
  const mailSend = await rig!.handoffId(mail.id)
  await rig!.settleAccepted(mailSend, 'reply')

  chat.closeDispatch()
  await eventually(() => expect(chat.dispatchedTo('a new task for you')).toHaveLength(1))
  expect(chat.dispatchedTo('a new task for you')).toEqual([chat.child()!.fence])
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
  expect(chat.mailDispatchedTo()).toEqual([chat.accountA])
})

it('keeps a held send through Stop, and Resume delivers it once on the new account', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  const sent = rig!.send('after the switch')
  await sent.result
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: sent.id, state: 'waiting' }])
  )
  expect(await rig!.stop()).toMatchObject({ ok: true })
  await eventually(() => expect(chat.child()).toBeNull())
  expect((await rig!.drafts()).map(({ messageId }) => messageId)).toEqual([sent.id])
  expect(await rig!.queuePause()).toEqual({ reason: 'stopped' })
  expect(chat.dispatchedTo('after the switch')).toEqual([])
  expect(await rig!.resume()).toMatchObject({ ok: true })
  await eventually(() => expect(chat.dispatchedTo('after the switch')).toHaveLength(1))
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
})

it('sends no usage-limit continue to the old account while its subagent still runs', async () => {
  const chat = await chatOnAccountA()
  const subagent = devServer({ id: 'child-agent', providerId: 'task-agent', kind: 'agent' })
  chat.background([subagent])
  await chat.limited()
  chat.switchTo('/homes/b')
  await chat.sweep(15_000)
  await chat.sweep(15_000)
  // Not even admitted: a continue accepted now would only wait for, or reach, the agent on A.
  expect(await chat.hostSends()).toEqual([])
  expect(await rig!.drafts()).toEqual([])

  chat.background([{ ...subagent, membership: 'settled', state: 'done', outcome: 'succeeded' }])
  await chat.sweep(15_000)
  await eventually(() => expect(chat.dispatchedTo('Continue where you left off')).toHaveLength(1))
  expect(chat.dispatchedTo('Continue where you left off')).toEqual([chat.child()!.fence])
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
})

it('still continues a usage-limited worker whose open Dispatch waits on that continue', async () => {
  const chat = await chatOnAccountA()
  chat.setOpenDispatch(true)
  await chat.limited()
  chat.switchTo('/homes/b')
  await chat.sweep(15_000)
  await chat.sweep(15_000)
  await chat.sweep(15_000)
  // Its Dispatch closes only once the worker continues; holding the continue would never end.
  await eventually(() => expect(chat.dispatchedTo('Continue where you left off')).toHaveLength(1))

  // Nothing is left held for it: later Dispatch events, each in its own tick, read and wake nothing.
  chat.closeDispatch()
  await new Promise((settled) => setImmediate(settled))
  const wake = vi.spyOn(rig!.host.collaboratorsForTests().conversationDelivery.loop, 'wake')
  const events = async (count: number) => {
    const before = chat.dispatchReads()
    for (let i = 0; i < count; i++) {
      chat.unrelatedDispatchChanges(1)
      await new Promise((settled) => setImmediate(settled))
    }
    return chat.dispatchReads() - before
  }
  expect(await events(10)).toBe(0)
  expect(await events(100)).toBe(0)
  expect(wake).not.toHaveBeenCalled()
})

it('lets go of the hold once the person deletes the message it held', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  const sent = rig!.send('never mind')
  await sent.result
  const session = () => rig!.host.collaboratorsForTests().sessions.get(SESSION)
  await eventually(() => expect(session()?.awaitsAccountMove).toBe(true))
  expect(await rig!.deleteQueued(sent.id)).toMatchObject({ ok: true })
  await eventually(() => expect(session()?.awaitsAccountMove).toBeUndefined())
  expect(chat.dispatchedTo('never mind')).toEqual([])
})

it('wakes a chat held on child work for none of 10 or 100 unrelated Dispatch changes', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  await rig!.send('held').result
  const host = rig!.host.collaboratorsForTests()
  await eventually(() => expect(host.sessions.get(SESSION)?.awaitsAccountMove).toBe(true))
  const wake = vi.spyOn(host.conversationDelivery.loop, 'wake')
  const reads = chat.accountReads()

  chat.unrelatedDispatchChanges(10)
  expect(wake).not.toHaveBeenCalled()
  chat.unrelatedDispatchChanges(100)
  expect(wake).not.toHaveBeenCalled()
  expect(chat.accountReads()).toBe(reads)
  expect(chat.dispatchedTo('held')).toEqual([])
})

it('takes a send back from the old account when its work shows up only after the send was accepted', async () => {
  const chat = await chatOnAccountA()
  chat.switchTo('/homes/b')
  // The agent reports a background command after the send is accepted, before it is handed over.
  chat.onHandoverAccountRead(() => chat.background([devServer()]))
  const sent = rig!.send('raced')
  expect(await sent.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: sent.id, state: 'waiting' }])
  )
  expect(chat.dispatchedTo('raced')).toEqual([])
  // Its accepted copy is answered by the card, so the chat shows it once.
  expect((await rig!.submission(sent.id))?.keptAsQueuedMessageId).toBe(sent.id)

  const mail = rig!.send('mail meanwhile', undefined, { internal: true, from: MAIL })
  await mail.result
  await eventually(() => expect(chat.mailDispatchedTo()).toEqual([chat.accountA]))
  await rig!.settleAccepted(await rig!.handoffId(mail.id), 'mail meanwhile')

  chat.background([devServer({ membership: 'settled', state: 'done', outcome: 'succeeded' })])
  await eventually(() => expect(chat.dispatchedTo('raced')).toHaveLength(1))
  expect(chat.dispatchedTo('raced')).toEqual([chat.child()!.fence])
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
})

it('never hands the old account a send it could not keep, and delivers it on the new one', async () => {
  const chat = await chatOnAccountA()
  chat.switchTo('/homes/b')
  const journal = rig!.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const write = journal.write.bind(journal)
  let failed = 0
  vi.spyOn(journal, 'write').mockImplementation(async (operation, ...rest) => {
    if (
      operation.kind === 'hold-unsent' &&
      operation.hold.cause === 'accountMove' &&
      failed++ === 0
    ) {
      throw new Error('disk full')
    }
    return write(operation, ...rest)
  })
  chat.onHandoverAccountRead(() => chat.background([devServer()]))
  const sent = rig!.send('unkept')
  expect(await sent.result).toMatchObject({ ok: true })
  await eventually(() => expect(failed).toBeGreaterThan(0))
  expect(chat.dispatchedTo('unkept')).toEqual([])

  chat.background([devServer({ membership: 'settled', state: 'done', outcome: 'succeeded' })])
  await eventually(() => expect(chat.dispatchedTo('unkept')).toHaveLength(1))
  expect(chat.dispatchedTo('unkept')).toEqual([chat.child()!.fence])
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
})

it('sends a queued card back to wait when the old account turns out busy as it is handed over', async () => {
  const chat = await chatOnAccountA()
  const first = rig!.send('first turn')
  await first.result
  await eventually(() => expect(chat.dispatchedTo('first turn')).toEqual([chat.accountA]))
  const queued = rig!.send('queued next', 'queue-if-active')
  await queued.result
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: queued.id, state: 'waiting' }])
  )
  chat.switchTo('/homes/b')
  // The agent reports a background command once the card is claimed, before it is handed over.
  chat.onHandoverAccountRead(() => chat.background([devServer()]))
  await rig!.settleAccepted(first.id, 'first turn')

  await eventually(() => expect(chat.accountReads()).toBeGreaterThan(0))
  // Its claimed attempt is proven undelivered, so the card waits again instead of reaching A.
  await eventually(async () =>
    expect((await rig!.handoff(queued.id))?.rejection).toMatchObject({ neverReachedAgent: true })
  )
  expect(await rig!.drafts()).toEqual([{ messageId: queued.id, state: 'waiting' }])
  expect(chat.dispatchedTo('queued next')).toEqual([])
  expect(chat.child()?.fence).toBe(chat.accountA)
})

it('delivers a kept queued card once on the new account after mail drains and the old work settles', async () => {
  const chat = await chatOnAccountA()
  const first = rig!.send('first turn')
  await first.result
  await eventually(() => expect(chat.dispatchedTo('first turn')).toEqual([chat.accountA]))
  const queued = rig!.send('queued next', 'queue-if-active')
  await queued.result
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: queued.id, state: 'waiting' }])
  )
  chat.switchTo('/homes/b')
  chat.onHandoverAccountRead(() => chat.background([devServer()]))
  await rig!.settleAccepted(first.id, 'first turn')
  await eventually(async () =>
    expect((await rig!.handoff(queued.id))?.rejection).toMatchObject({ neverReachedAgent: true })
  )

  const mail = rig!.send('mail meanwhile', undefined, { internal: true, from: MAIL })
  await mail.result
  await eventually(() => expect(chat.mailDispatchedTo()).toEqual([chat.accountA]))
  await rig!.settleAccepted(await rig!.handoffId(mail.id), 'mail meanwhile')

  chat.background([devServer({ membership: 'settled', state: 'done', outcome: 'succeeded' })])
  await eventually(() => expect(chat.dispatchedTo('queued next')).toHaveLength(1))
  expect(chat.dispatchedTo('queued next')).toEqual([chat.child()!.fence])
  expect(chat.child()!.fence).not.toBe(chat.accountA)
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
})

it('delivers a kept queued card once on the new account when the old work settles right after', async () => {
  const chat = await chatOnAccountA()
  const first = rig!.send('first turn')
  await first.result
  await eventually(() => expect(chat.dispatchedTo('first turn')).toEqual([chat.accountA]))
  const queued = rig!.send('queued next', 'queue-if-active')
  await queued.result
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: queued.id, state: 'waiting' }])
  )
  chat.switchTo('/homes/b')
  chat.onHandoverAccountRead(() => chat.background([devServer()]))
  await rig!.settleAccepted(first.id, 'first turn')
  await eventually(async () =>
    expect((await rig!.handoff(queued.id))?.rejection).toMatchObject({ neverReachedAgent: true })
  )
  chat.background([devServer({ membership: 'settled', state: 'done', outcome: 'succeeded' })])

  await eventually(() => expect(chat.dispatchedTo('queued next')).toHaveLength(1))
  expect(chat.dispatchedTo('queued next')).toEqual([chat.child()!.fence])
  expect(chat.child()!.fence).not.toBe(chat.accountA)
})

it("reads a held chat's own Dispatch once per burst and wakes it for none of 10 or 100 other Dispatch changes", async () => {
  const chat = await chatOnAccountA()
  chat.setOpenDispatch(true)
  chat.switchTo('/homes/b')
  await rig!.send('held for the dispatch').result
  const host = rig!.host.collaboratorsForTests()
  await eventually(() => expect(host.sessions.get(SESSION)?.awaitsAccountMove).toBe(true))
  const wake = vi.spyOn(host.conversationDelivery.loop, 'wake')
  const burst = async (count: number) => {
    const before = chat.dispatchReads()
    chat.unrelatedDispatchChanges(count)
    await new Promise((settled) => setImmediate(settled))
    return chat.dispatchReads() - before
  }

  expect(await burst(10)).toBe(1)
  expect(await burst(100)).toBe(1)
  expect(wake).not.toHaveBeenCalled()
  expect(chat.dispatchedTo('held for the dispatch')).toEqual([])
})

it('reads no Dispatch custody again for a due continue that stays on its account, over 10 or 100 sweeps', async () => {
  const chat = await chatOnAccountA()
  await chat.limited()
  await chat.sweep(15_000)
  const sweeps = async (count: number) => {
    const before = chat.dispatchReads()
    for (let i = 0; i < count; i++) {
      await chat.sweep(0)
    }
    return chat.dispatchReads() - before
  }

  expect(await sweeps(10)).toBe(0)
  expect(await sweeps(100)).toBe(0)
})

it('delivers a held send once on the new account at the two-minute recheck when the Dispatch edge is missed', async () => {
  const chat = await chatOnAccountA()
  chat.setOpenDispatch(true)
  chat.switchTo('/homes/b')
  const timers = vi.spyOn(globalThis, 'setTimeout')
  const rechecks = () =>
    timers.mock.calls.flatMap(([run, ms]) =>
      ms === 2 * 60_000 + 1 && typeof run === 'function' ? [run] : []
    )
  const sent = rig!.send('held past a missed edge')
  await sent.result
  const host = rig!.host.collaboratorsForTests()
  await eventually(() => expect(host.sessions.get(SESSION)?.awaitsAccountMove).toBe(true))
  expect(rechecks().length).toBeGreaterThan(0)

  // The Dispatch settles, but its orchestration event never reaches this chat.
  chat.setOpenDispatch(false)
  await rig!.drafts()
  expect(chat.dispatchedTo('held past a missed edge')).toEqual([])

  rechecks().at(-1)!()
  await eventually(() => expect(chat.dispatchedTo('held past a missed edge')).toHaveLength(1))
  expect(chat.dispatchedTo('held past a missed edge')).toEqual([chat.child()!.fence])
  expect(chat.child()!.fence).not.toBe(chat.accountA)
})

it('scans no queued card for publication while 10 or 100 held cards are all from the person', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  const journal = rig!.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  let queued = 0
  const scans = async (cards: number) => {
    for (; queued < cards; queued++) {
      await rig!.send(`held ${queued}`).result
    }
    await eventually(async () => expect(await rig!.drafts()).toHaveLength(cards))
    const work = vi.spyOn(journal.reads, 'work')
    const queue = vi.spyOn(journal.reads, 'queue')
    for (let i = 0; i < 10; i++) {
      expect(await chat.nextQueued()).toBeNull()
    }
    const scanned =
      work.mock.calls.filter(([read]) => read.operation.kind === 'input').length +
      queue.mock.calls.filter(([read]) => read.kind === 'eligible-input-card').length
    work.mockRestore()
    queue.mockRestore()
    return scanned
  }

  expect(await scans(10)).toBe(0)
  expect(await scans(100)).toBe(0)
})

it('reads the account again when the selection changes with no edge, so a send never reaches the old account', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  const first = rig!.send('on the same account')
  await first.result
  await eventually(() => expect(chat.dispatchedTo('on the same account')).toEqual([chat.accountA]))
  await rig!.settleAccepted(first.id, 'on the same account')

  chat.switchSilentlyTo('/homes/b')
  const sent = rig!.send('after the prune')
  await sent.result
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: sent.id, state: 'waiting' }])
  )
  expect(chat.dispatchedTo('after the prune')).toEqual([])
  // Held as it was admitted, not only taken back at handover.
  expect((await rig!.submission(sent.id))?.keptAsQueuedMessageId).toBeUndefined()

  chat.background([devServer({ membership: 'settled', state: 'done', outcome: 'succeeded' })])
  await eventually(() => expect(chat.dispatchedTo('after the prune')).toHaveLength(1))
  expect(chat.dispatchedTo('after the prune')).not.toEqual([chat.accountA])
})
