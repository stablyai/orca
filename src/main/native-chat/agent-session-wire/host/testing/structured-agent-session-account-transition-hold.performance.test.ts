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
