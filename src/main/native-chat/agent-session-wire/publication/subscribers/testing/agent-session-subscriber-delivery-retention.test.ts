import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

const SNAPSHOTS = 2_000

async function collect(): Promise<void> {
  if (!global.gc) {
    throw new Error('This retention test requires --expose-gc')
  }
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    global.gc()
  }
}

async function blockedSubscriber() {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, 'chat')
  })
  const subscribers = new AgentSessionSubscribers()
  const transport = Promise.withResolvers<void>()
  let blocked = false
  const events: AgentSessionSubscribeEvent[] = []
  const close = subscribers.open({
    id: 'pane',
    sessionId: SESSION,
    journal,
    fence: 1,
    emit: (event) => events.push(event),
    projectJournalEvent: async (_journal, event) => {
      if (blocked) {
        await transport.promise
      }
      return event
    }
  })
  await vi.waitFor(() => expect(events.length).toBeGreaterThan(0))
  blocked = true
  const snapshots: WeakRef<object>[] = []
  // Distinct growing text, as a streaming reply publishes it.
  const publish = (index: number): void => {
    const items: AgentJournalRenderItem[] = [
      {
        itemId: 'orca:text',
        revision: index + 1,
        sequence: journal.cursor().sequence,
        observedAt: index,
        turnScope: { kind: 'thread' },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `${index}:`.padEnd(32 * 1024, 'x') }]
        }
      }
    ]
    snapshots.push(new WeakRef(items))
    subscribers.publishLiveText(SESSION, journal, 1, items)
  }
  const alive = async (): Promise<number> => {
    await collect()
    return snapshots.filter((ref) => ref.deref() !== undefined).length
  }
  return { publish, alive, close, events, release: () => transport.resolve() }
}

it('retains only the active and newest live text behind a stalled transport', async () => {
  const pane = await blockedSubscriber()
  for (let index = 0; index < SNAPSHOTS; index++) {
    pane.publish(index)
    await Promise.resolve()
  }
  expect(await pane.alive()).toBeLessThanOrEqual(2)

  const before = pane.events.length
  pane.release()
  await vi.waitFor(() => expect(pane.events.length).toBe(before + 2))
  const latest = pane.events.at(-1)
  expect(latest).toMatchObject({
    type: 'batch',
    batch: { items: [{ revision: SNAPSHOTS }] }
  })
  pane.close()
})

it('releases waiting live text when the subscriber closes during a stalled delivery', async () => {
  const pane = await blockedSubscriber()
  pane.publish(0)
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (let index = 1; index < SNAPSHOTS; index++) {
    pane.publish(index)
  }
  pane.close()
  expect(await pane.alive()).toBeLessThanOrEqual(1)
  pane.release()
})
