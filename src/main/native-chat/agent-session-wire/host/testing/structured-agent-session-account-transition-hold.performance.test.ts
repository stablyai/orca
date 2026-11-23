// Perf contracts for #43145: a chat held on an account move costs no reads or wakes per unrelated event,
// sweep or publication. Each fails when its bound is reverted.
import { afterEach, expect, it, vi } from 'vitest'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'
import {
  chatOnAccountA,
  devServer,
  rig
} from './structured-agent-session-account-transition-hold.test-fixture'

afterEach(async () => rig?.dispose())

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

it("reads and wakes nothing for 10 or 100 other workers' Dispatch ends, then sends once when its own ends", async () => {
  const chat = await chatOnAccountA()
  chat.setOpenDispatch(true)
  chat.switchTo('/homes/b')
  await rig!.send('held for the dispatch').result
  const host = rig!.host.collaboratorsForTests()
  await eventually(() => expect(host.sessions.get(SESSION)?.awaitsAccountMove).toBe(true))
  const wake = vi.spyOn(host.conversationDelivery.loop, 'wake')
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
  expect(chat.dispatchedTo('held for the dispatch')).toEqual([])

  chat.closeDispatch()
  await eventually(() => expect(chat.dispatchedTo('held for the dispatch')).toHaveLength(1))
  expect(chat.dispatchedTo('held for the dispatch')).not.toEqual([chat.accountA])
})

it('reads the account once per send, at its handover only, over 10 or 100 sends that stay on their account', async () => {
  const chat = await chatOnAccountA()
  let sent = 0
  const sends = async (count: number) => {
    const before = chat.accountReads()
    for (const end = sent + count; sent < end; sent++) {
      const text = `same account ${sent}`
      const send = rig!.send(text)
      await send.result
      await eventually(() => expect(chat.dispatchedTo(text)).toEqual([chat.accountA]))
      await rig!.settleAccepted(send.id, text)
    }
    return chat.accountReads() - before
  }

  // The first send learns its child stays on the account; admission reads nothing after that.
  await sends(1)
  expect(await sends(10)).toBe(10)
  expect(await sends(100)).toBe(100)
}, 60_000)

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

it("leaves no hold behind a usage-limited worker's continue: 10 or 100 Dispatch events read and wake nothing", async () => {
  const chat = await chatOnAccountA()
  chat.setOpenDispatch(true)
  await chat.limited()
  chat.switchTo('/homes/b')
  await chat.sweep(15_000)
  await chat.sweep(15_000)
  await chat.sweep(15_000)
  // Its Dispatch closes only once the worker continues; holding the continue would never end.
  await eventually(() => expect(chat.dispatchedTo('Continue where you left off')).toHaveLength(1))

  // Nothing is left held for it: Dispatch events, each in its own tick, read and wake nothing,
  // while its Dispatch stays open and after it closes.
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
  chat.closeDispatch()
  await new Promise((settled) => setImmediate(settled))
  expect(await events(10)).toBe(0)
  expect(await events(100)).toBe(0)
  expect(wake).not.toHaveBeenCalled()
})

it('runs no queue drain for 10 or 100 child-work reports in a chat nothing holds', async () => {
  const chat = await chatOnAccountA()
  const journal = rig!.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const write = vi.spyOn(journal, 'write')
  const drains = () =>
    write.mock.calls.filter(([operation]) => operation.kind === 'automatic-submission').length
  for (const reports of [10, 100]) {
    const before = drains()
    for (let i = 0; i < reports; i++) {
      chat.background([
        devServer({
          id: `child-${reports}-${i}`,
          membership: 'settled',
          state: 'done',
          outcome: 'succeeded'
        })
      ])
      await new Promise((settled) => setImmediate(settled))
    }
    await rig!.drafts()
    expect(drains() - before).toBe(0)
  }
})

it('reads and wakes nothing for 10 or 100 unrelated settings writes while a send waits on a System-default home', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  const homes = chat.followSystemDefaultHome()
  homes.homeTo('/homes/b')
  await rig!.send('held on b').result
  const host = rig!.host.collaboratorsForTests()
  await eventually(() => expect(host.sessions.get(SESSION)?.awaitsAccountMove).toBe(true))
  const wake = vi.spyOn(host.conversationDelivery.loop, 'wake')
  const reads = chat.accountReads()

  for (let i = 0; i < 10; i++) {
    homes.unrelatedWrite(i)
  }
  expect(wake).not.toHaveBeenCalled()
  for (let i = 0; i < 100; i++) {
    homes.unrelatedWrite(i)
  }
  expect(wake).not.toHaveBeenCalled()
  expect(chat.accountReads()).toBe(reads)
  expect(chat.dispatchedTo('held on b')).toEqual([])
})

it('leaves no retry behind keeps that kept failing once the send is delivered on the new account', async () => {
  const chat = await chatOnAccountA()
  chat.switchTo('/homes/b')
  const journal = rig!.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const write = journal.write.bind(journal)
  let failed = 0
  vi.spyOn(journal, 'write').mockImplementation(async (operation, ...rest) => {
    if (operation.kind === 'hold-unsent' && operation.hold.cause === 'accountMove') {
      failed++
      throw new Error('disk full')
    }
    return write(operation, ...rest)
  })
  const timers = vi.spyOn(globalThis, 'setTimeout')
  const cleared = vi.spyOn(globalThis, 'clearTimeout')
  chat.onHandoverAccountRead(() => chat.background([devServer()]))
  await rig!.send('unkept').result
  await eventually(() => expect(failed).toBeGreaterThan(0))

  chat.background([devServer({ membership: 'settled', state: 'done', outcome: 'succeeded' })])
  await eventually(() => expect(chat.dispatchedTo('unkept')).toHaveLength(1))
  // The keep retry's backoff steps, from five seconds to its five-minute cap.
  const steps = new Set([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000])
  const retries = timers.mock.calls.flatMap(([, ms], index) =>
    steps.has(ms ?? 0) ? [timers.mock.results[index]!.value] : []
  )
  expect(retries.length).toBeGreaterThan(0)
  // Each cleared, so none wakes the chat again.
  const clearedHandles = new Set(cleared.mock.calls.map(([handle]) => handle))
  expect(retries.filter((handle) => !clearedHandles.has(handle))).toEqual([])
})
