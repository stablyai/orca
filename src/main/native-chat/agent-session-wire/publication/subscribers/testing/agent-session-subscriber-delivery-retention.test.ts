import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  CHAT_LIVE_TEXT_RETAINED_BYTES,
  chatLiveTextRetainedBytes
} from '../../../../retention/chat-path-retained-bytes'
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
  readLiveText?: () => readonly AgentJournalRenderItem[],
  whileOpening?: (publish: (index: number, characters?: number) => void) => void
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
  const subscribers = new AgentSessionSubscribers(readLiveText ? { readLiveText } : {})
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

it('ends the stream instead of holding live text past the chat budget', async () => {
  const pane = await blockedSubscriber()
  pane.publish(0)
  await Promise.resolve()
  const others = chatLiveTextRetainedBytes.claim(CHAT_LIVE_TEXT_RETAINED_BYTES)
  try {
    // Waits behind the stalled delivery, so it needs budget the chat no longer has.
    pane.publish(1)
    expect(pane.ends).toHaveLength(1)
    // Only the stalled delivery's own snapshot is left.
    expect(await pane.alive()).toBeLessThanOrEqual(1)
  } finally {
    others?.()
    pane.release()
  }
})

it('ends only the stream whose own live text outgrows its share', async () => {
  const large = await blockedSubscriber('large-session')
  const small = await blockedSubscriber('small-session')
  try {
    // 3M characters each: the delivering snapshot plus a waiting one pass 8 MiB at two bytes each.
    large.publish(0, 3_000_000)
    small.publish(0)
    await Promise.resolve()
    large.publish(1, 3_000_000)
    small.publish(1)
    expect(large.ends).toHaveLength(1)
    expect(small.ends).toHaveLength(0)
  } finally {
    large.release()
    small.release()
  }
})

it('ends a stream whose one live text alone outgrows its share', async () => {
  const pane = await blockedSubscriber()
  try {
    // 5M characters at two bytes each, with nothing else in flight.
    pane.publish(0, 5_000_000)
    expect(pane.ends).toHaveLength(1)
  } finally {
    pane.release()
  }
})

it('ends a stream whose opening would send live text past its share', async () => {
  const text = textItem('x'.repeat(5_000_000))
  const pane = await blockedSubscriber('opening-session', () => [text])
  try {
    await vi.waitFor(() => expect(pane.ends).toHaveLength(1))
  } finally {
    pane.release()
  }
})

it('counts live text an opening sends once, not again for the copy waiting behind it', async () => {
  // 3M characters each: the opening's text plus the waiting copy would pass 8 MiB together.
  const text = textItem('x'.repeat(3_000_000))
  const pane = await blockedSubscriber(
    'adopting-session',
    () => [text],
    (publish) => publish(0, 3_000_000)
  )
  try {
    expect(pane.ends).toHaveLength(0)
  } finally {
    pane.release()
  }
})
