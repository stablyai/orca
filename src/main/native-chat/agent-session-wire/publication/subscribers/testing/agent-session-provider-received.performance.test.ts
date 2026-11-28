import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import type { AgentSessionSubscribeInput } from '../agent-session-subscribe-input'
import { SubscriberDeliveryLane } from '../agent-session-subscriber-delivery-lane'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

// PR #51346: receipt work stays within the recipients of an exact pending send.
it.each([
  [2, 0],
  [20, 0],
  [2, 1],
  [20, 1],
  [2, 3],
  [20, 3]
])(
  'keeps catch-up first and standalone work proportional to %i receipts and %i local readers',
  async (count, windows) => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'claude',
        providerHandle: claudeProviderHandle('provider-1', null)
      },
      stateDirectory: join(fixture.root, SESSION)
    })
    const subscribers = new AgentSessionSubscribers({ now: () => 100 })
    const idle = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await vi.waitFor(() => expect(subscribers.retention(new Set())).toEqual([]))
    }
    const open = (
      id: string,
      readsProviderReceived: boolean,
      boundedFrames = false,
      projectJournalEvent?: AgentSessionSubscribeInput['projectJournalEvent']
    ) => {
      const events: AgentSessionSubscribeEvent[] = []
      const close = subscribers.open({
        id,
        sessionId: SESSION,
        journal,
        fence: 1,
        readsProviderReceived,
        boundedFrames,
        projectJournalEvent,
        emit: (event) => events.push(event)
      })
      return { events, close }
    }
    const wrappers = vi.spyOn(subscribers.providerReceipts, 'track')
    const desktop = Array.from({ length: windows }, (_, index) => open(`desktop-${index}`, true))
    const remote = open('remote', false)
    const phone = open('phone', false, true)
    let barrier: Promise<void> | undefined
    const stalled = windows
      ? open('lagging-desktop', true, false, async (_journal, event) => {
          await barrier
          return event
        })
      : undefined
    await idle()
    expect(wrappers).toHaveBeenCalledTimes(windows + Number(!!stalled))
    const originalCounts = desktop.map(({ events }) => events.length)
    const jobs = vi.spyOn(SubscriberDeliveryLane.prototype, 'scheduleProviderReceipt')
    const jobCount = () => jobs.mock.results.filter(({ value }) => value === true).length
    const append = (id: string) =>
      journal.appendItem(
        { provider: 'orca', clientMessageId: id },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    const blocked = Promise.withResolvers<void>()
    try {
      barrier = blocked.promise
      await append('before-first-handover')
      subscribers.deliverFrames(SESSION, journal)
      await vi.waitFor(() => {
        desktop.forEach(({ events }, index) =>
          expect(events).toHaveLength(originalCounts[index]! + 1)
        )
      })
      for (let index = 0; index < count; index++) {
        const clientMessageId = `covered-${index}`
        const cursor = await handover(journal, clientMessageId, windows > 0)
        const receive = subscribers.providerReceipts.bind({
          journal,
          clientMessageId,
          cursor,
          fence: 1,
          provider: 'claude',
          owns: () => true
        })
        subscribers.deliverFrames(SESSION, journal)
        expect(!!receive).toBe(windows > 0)
        receive?.(() => true)
        await vi.waitFor(() => {
          desktop.forEach(({ events }, reader) => {
            expect(events).toHaveLength(originalCounts[reader]! + 2 + index)
            expect(events.at(-1)).toMatchObject({ providerReceived: [cursor.sequence] })
          })
        })
      }
      blocked.resolve()
      await idle()
      if (stalled) {
        expect(
          stalled.events.flatMap((event) =>
            event.type === 'batch' ? (event.providerReceived ?? []) : []
          )
        ).toHaveLength(count)
        stalled.close()
      }
      expect(jobCount()).toBe(0)
      const remoteBytes = JSON.stringify(remote.events)
      const phoneBytes = JSON.stringify(phone.events)
      expect(remoteBytes).not.toContain('providerReceived')
      expect(phoneBytes).not.toContain('providerReceived')

      for (let index = 0; index < count; index++) {
        const clientMessageId = `standalone-${index}`
        await handover(journal, clientMessageId, windows > 0)
        const receive = subscribers.providerReceipts.bind({
          journal,
          clientMessageId,
          cursor: journal.cursor(),
          fence: 1,
          provider: 'claude',
          owns: () => true
        })
        subscribers.deliverFrames(SESSION, journal)
        await idle()
        receive?.(() => true)
        receive?.(() => true)
        await idle()
      }
      desktop.forEach(({ events }, index) => {
        expect(events).toHaveLength(originalCounts[index]! + 1 + 3 * count)
        expect(events.at(-1)).toEqual({
          type: 'batch',
          sessionId: SESSION,
          fence: 1,
          providerReceived: [journal.cursor().sequence],
          batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
        })
      })
      expect(jobCount()).toBe(count * windows)
      expect(JSON.stringify(remote.events.slice(0, JSON.parse(remoteBytes).length))).toBe(
        remoteBytes
      )
      expect(JSON.stringify(phone.events.slice(0, JSON.parse(phoneBytes).length))).toBe(phoneBytes)
      expect(JSON.stringify(remote.events)).not.toContain('providerReceived')
      expect(JSON.stringify(phone.events)).not.toContain('providerReceived')
      if (windows) {
        const successor = open('desktop-0', true)
        desktop[0]?.close()
        await idle()
        expect(successor.events).toHaveLength(1)
        expect(JSON.stringify(successor.events)).not.toContain('providerReceived')
      }
    } finally {
      blocked.resolve()
      jobs.mockRestore()
      wrappers.mockRestore()
    }
  }
)

it.each([
  [1, 1],
  [10, 1],
  [1, 10],
  [10, 10]
])(
  'visits only confirmed work at %i attempts and %i readers',
  async (attemptCount, readerCount) => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'claude',
        providerHandle: claudeProviderHandle('provider-1', null)
      },
      stateDirectory: join(fixture.root, SESSION)
    })
    const subscribers = new AgentSessionSubscribers({ now: () => 100 })
    const receipts = subscribers.providerReceipts
    const close = Array.from({ length: readerCount }, (_, index) =>
      subscribers.open({
        id: String(index),
        sessionId: SESSION,
        journal,
        fence: 1,
        readsProviderReceived: true,
        emit: () => {}
      })
    )
    const idle = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await vi.waitFor(() => expect(subscribers.retention(new Set())).toEqual([]))
    }
    try {
      await idle()
      const owns = vi.fn(() => true)
      const pending = vi.fn(() => true)
      const receive: ReturnType<typeof receipts.bind>[] = []
      const append = async (clientMessageId: string) => {
        await journal.appendItem(
          { provider: 'orca', clientMessageId },
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'output' }] },
          { fence: 1, turnScope: { kind: 'thread' } }
        )
      }
      for (let index = 0; index < attemptCount; index++) {
        const clientMessageId = `send-${index}`
        await handover(journal, clientMessageId, true)
        receive.push(
          receipts.bind({
            journal,
            clientMessageId,
            cursor: journal.cursor(),
            fence: 1,
            provider: 'claude',
            owns
          })
        )
        subscribers.deliverFrames(SESSION, journal)
        await idle()
      }
      const stop = journal.observeCommits((commit) => receipts.observe(journal, commit))
      try {
        const unrelatedTraffic = async (id: string) => {
          owns.mockClear()
          pending.mockClear()
          await append(id)
          subscribers.deliverFrames(SESSION, journal)
          await idle()
          expect([owns, pending].map((counter) => counter.mock.calls.length)).toEqual([0, 0])
        }
        expect(receive.filter(Boolean)).toHaveLength(attemptCount)
        await unrelatedTraffic('before')
        receive.forEach((confirm) => confirm?.(pending))
        await idle()
        expect(pending).toHaveBeenCalledTimes(attemptCount * (1 + readerCount))
        await unrelatedTraffic('after')
      } finally {
        stop()
      }
    } finally {
      close.forEach((dispose) => dispose())
    }
  }
)

async function handover(
  journal: Parameters<AgentSessionSubscribers['open']>[0]['journal'],
  clientMessageId: string,
  captureProviderReceipt: boolean
) {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'hello' }]
  }
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: clientMessageId,
    handoverRecorded: true,
    fence: 1,
    body
  })
  const result = await journal.prepareHandover({
    clientMessageId,
    fence: 1,
    turnScope: { kind: 'thread' },
    body,
    captureProviderReceipt
  })
  expect(!!result.dispatchCursor).toBe(captureProviderReceipt)
  return journal.cursor()
}
