import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import { SubscriberDeliveryLane } from '../agent-session-subscriber-delivery-lane'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

it.each([
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
    const open = (id: string, readsProviderReceived: boolean, boundedFrames = false) => {
      const events: AgentSessionSubscribeEvent[] = []
      const close = subscribers.open({
        id,
        sessionId: SESSION,
        journal,
        fence: 1,
        readsProviderReceived,
        boundedFrames,
        emit: (event) => events.push(event)
      })
      return { events, close }
    }
    const desktop = Array.from({ length: windows }, (_, index) => open(`desktop-${index}`, true))
    const remote = open('remote', false)
    const phone = open('phone', false, true)
    await idle()
    const originalCounts = desktop.map(({ events }) => events.length)
    const jobs = vi.spyOn(SubscriberDeliveryLane.prototype, 'providerReceived')
    try {
      const sends: {
        receive: ReturnType<AgentSessionSubscribers['providerReceipts']['bind']>
        sequence: number
      }[] = []
      for (let index = 0; index < count; index++) {
        await journal.appendItem(
          { provider: 'orca', clientMessageId: `covered-${index}` },
          { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
          { fence: 1, turnScope: { kind: 'thread' } }
        )
        const cursor = journal.cursor()
        const receive = subscribers.providerReceipts.bind({
          journal,
          clientMessageId: `covered-${index}`,
          cursor,
          fence: 1,
          provider: 'claude',
          owns: () => true
        })
        sends.push({ receive, sequence: cursor.sequence })
      }
      subscribers.deliverFrames(SESSION, journal)
      for (const { receive } of sends) {
        receive?.(() => true)
      }
      await idle()
      desktop.forEach(({ events }, index) => {
        expect(events).toHaveLength(originalCounts[index]! + 1)
        expect(events.at(-1)).toMatchObject({
          providerReceived: sends.map(({ sequence }) => sequence)
        })
      })
      expect(jobs).toHaveBeenCalledTimes(windows)
      const remoteBytes = JSON.stringify(remote.events)
      const phoneBytes = JSON.stringify(phone.events)
      expect(remoteBytes).not.toContain('providerReceived')
      expect(phoneBytes).not.toContain('providerReceived')

      for (let index = 0; index < count; index++) {
        const receive = subscribers.providerReceipts.bind({
          journal,
          clientMessageId: `standalone-${index}`,
          cursor: journal.cursor(),
          fence: 1,
          provider: 'claude',
          owns: () => true
        })
        receive?.(() => true)
        receive?.(() => true)
        await idle()
      }
      desktop.forEach(({ events }, index) => {
        expect(events).toHaveLength(originalCounts[index]! + 1 + count)
        expect(events.at(-1)).toEqual({
          type: 'batch',
          sessionId: SESSION,
          fence: 1,
          providerReceived: [journal.cursor().sequence],
          batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
        })
      })
      expect(jobs).toHaveBeenCalledTimes((count + 1) * windows)
      expect(JSON.stringify(remote.events)).toBe(remoteBytes)
      expect(JSON.stringify(phone.events)).toBe(phoneBytes)
      const successor = open('desktop-0', true)
      desktop[0]?.close()
      await idle()
      expect(successor.events).toHaveLength(1)
      expect(JSON.stringify(successor.events)).not.toContain('providerReceived')
    } finally {
      jobs.mockRestore()
    }
  }
)
