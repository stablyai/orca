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

function textItem(text: string, revision = 1, sequence = 0): AgentJournalRenderItem {
  return {
    itemId: 'orca:text',
    revision,
    sequence,
    observedAt: revision - 1,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

async function blockedSubscriber(
  sessionId = SESSION,
  {
    readLiveText,
    whileOpening,
    subscribers = new AgentSessionSubscribers(readLiveText ? { readLiveText } : {})
  }: {
    readLiveText?: () => readonly AgentJournalRenderItem[]
    whileOpening?: (publish: (index: number, characters?: number) => void) => void
    subscribers?: AgentSessionSubscribers
  } = {}
) {
  const journal = await journals.open({
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, sessionId)
  })
  const ends: unknown[] = []
  const transport = Promise.withResolvers<void>()
  let blocked = false
  const events: AgentSessionSubscribeEvent[] = []
  const snapshots: WeakRef<object>[] = []
  // Distinct growing text, as a streaming reply publishes it.
  const publish = (index: number, characters = 32 * 1024): void => {
    const items = [
      textItem(`${index}:`.padEnd(characters, 'x'), index + 1, journal.cursor().sequence)
    ]
    snapshots.push(new WeakRef(items))
    subscribers.publishLiveText(sessionId, journal, 1, items)
  }
  const close = subscribers.open({
    id: 'pane',
    sessionId,
    journal,
    fence: 1,
    liveTextViewer: 'pane',
    liveTextShown: true,
    emit: (event) => events.push(event),
    end: (cause) => ends.push(cause),
    projectJournalEvent: async (_journal, event) => {
      if (blocked) {
        await transport.promise
      }
      return event
    }
  })
  whileOpening?.(publish)
  await vi.waitFor(() => expect(events.length).toBeGreaterThan(0))
  blocked = true
  const alive = async (): Promise<number> => {
    await collect()
    return snapshots.filter((ref) => ref.deref() !== undefined).length
  }
  return { publish, alive, close, events, ends, release: () => transport.resolve() }
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

it('ends only the stream whose own live text outgrows its cap', async () => {
  const subscribers = new AgentSessionSubscribers()
  const large = await blockedSubscriber('large-session', { subscribers })
  const small = await blockedSubscriber('small-session', { subscribers })
  try {
    // 3M characters each: the delivering snapshot plus a waiting one pass 8 MiB at two bytes each.
    large.publish(0, 3_000_000)
    small.publish(0)
    await Promise.resolve()
    expect(large.ends).toEqual([])

    large.publish(1, 3_000_000)
    small.publish(1)
    expect(large.ends).toEqual([expect.objectContaining({ name: 'SubscriberLiveTextCapReached' })])
    expect(small.ends).toEqual([])
    small.release()
    await vi.waitFor(() =>
      expect(small.events.at(-1)).toMatchObject({
        type: 'batch',
        batch: { items: [{ revision: 2 }] }
      })
    )
  } finally {
    large.release()
    small.release()
    small.close()
  }
})

it('ends a stream whose opening would send live text past its cap', async () => {
  const text = textItem('x'.repeat(5_000_000))
  const pane = await blockedSubscriber('opening-session', { readLiveText: () => [text] })
  try {
    await vi.waitFor(() => expect(pane.ends).toHaveLength(1))
  } finally {
    pane.release()
  }
})

it('counts live text an opening sends once, not again for the copy waiting behind it', async () => {
  // 3M characters each: the opening's text plus the waiting copy would pass 8 MiB together.
  const text = textItem('x'.repeat(3_000_000))
  const pane = await blockedSubscriber('adopting-session', {
    readLiveText: () => [text],
    whileOpening: (publish) => publish(0, 3_000_000)
  })
  try {
    await vi.waitFor(() =>
      expect(pane.events).toContainEqual(
        expect.objectContaining({
          type: 'batch',
          // Sent with the per-row bounds every live row gets.
          batch: expect.objectContaining({
            items: [expect.objectContaining({ itemId: text.itemId })]
          })
        })
      )
    )
    expect(pane.ends).toHaveLength(0)
  } finally {
    pane.release()
  }
})
