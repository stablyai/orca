import { afterEach, expect, it, vi } from 'vitest'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'
import {
  MAIL,
  chatOnAccountA,
  devServer,
  rig
} from './structured-agent-session-account-transition-hold.test-fixture'

afterEach(async () => rig?.dispose())

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

it("continues a usage-limited worker past the person's held message, then sends that message once on the new account", async () => {
  const chat = await chatOnAccountA()
  chat.setOpenDispatch(true)
  await chat.limited()
  chat.switchTo('/homes/b')
  await rig!.send('after the dispatch').result
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([expect.objectContaining({ state: 'waiting' })])
  )
  // Resuming the queue the failed turn paused makes the held message the queue's next card.
  expect(await rig!.resume()).toMatchObject({ ok: true })
  await chat.sweep(15_000)
  await chat.sweep(15_000)
  // Its Dispatch closes only after this continue, so a continue the held message refused would
  // leave both waiting for good.
  await eventually(() =>
    expect(chat.dispatchedTo('Continue where you left off')).toEqual([chat.accountA])
  )
  expect(chat.dispatchedTo('after the dispatch')).toEqual([])

  chat.closeDispatch()
  await eventually(() => expect(chat.dispatchedTo('after the dispatch')).toHaveLength(1))
  expect(chat.dispatchedTo('after the dispatch')).not.toEqual([chat.accountA])
})

it('sends on the old account when the person switches back while the move is still being read', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  chat.switchDuringNextAccountRead('/homes/a')
  await rig!.send('back on a').result
  await eventually(() => expect(chat.dispatchedTo('back on a')).toEqual([chat.accountA]))
})
