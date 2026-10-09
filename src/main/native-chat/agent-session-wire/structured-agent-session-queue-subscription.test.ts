import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { readQueuePublication } from './structured-agent-session-queued-publication'
import { readQueueSummary } from './structured-agent-session-queue-summary'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { buildSubscriberFrame } from './agent-session-subscriber-frame-fields'
import {
  PAGE_GATE,
  PAGE_SESSION,
  queuePageRig,
  type QueuePageRig
} from './agent-session-queue-pages.test-fixture'

let rig: QueuePageRig
beforeEach(async () => {
  rig = await queuePageRig()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rig.close()
})

function subscribers() {
  return new AgentSessionSubscribers({
    readQueuePublication: (_id, view) =>
      view === 'paged-v1'
        ? readQueueSummary(rig.journal, PAGE_GATE)
        : readQueuePublication(rig.journal, PAGE_GATE)
  })
}

function summary(event: AgentSessionSubscribeEvent | undefined) {
  if (!event || event.type === 'end') {
    throw new Error('expected a queue frame')
  }
  expect(event).not.toHaveProperty('queuedMessages')
  if (event.type === 'snapshot' || event.type === 'reset') {
    expect(event.page).not.toHaveProperty('queuedMessages')
  }
  return event.queueSummary
}

it('pins byte-identical legacy frames and uses summary-only snapshots, resets and changed batches for opt-in', async () => {
  await rig.insert('first')
  const registry = subscribers()
  const legacy: AgentSessionSubscribeEvent[] = []
  const paged: AgentSessionSubscribeEvent[] = []
  registry.open({
    id: 'legacy',
    sessionId: PAGE_SESSION,
    journal: rig.journal,
    fence: 1,
    emit: (event) => legacy.push(event)
  })
  registry.open({
    id: 'paged',
    sessionId: PAGE_SESSION,
    journal: rig.journal,
    fence: 1,
    queueView: 'paged-v1',
    emit: (event) => paged.push(event)
  })
  expect(summary(paged[0])?.total).toBe(1)
  const publication = readQueuePublication(rig.journal, PAGE_GATE)
  const event = {
    type: 'batch' as const,
    sessionId: PAGE_SESSION,
    batch: { cursor: rig.journal.cursor(), items: [], removedItemIds: [], submissions: [] }
  }
  const expected = {
    ...event,
    queuedMessages: publication.queuedMessages,
    queuePause: publication.queuePause,
    nextQueuedMessageId: publication.nextQueuedMessageId
  }
  const actual = buildSubscriberFrame(
    { readQueuePublication: () => publication },
    { sessionId: PAGE_SESSION },
    event,
    false
  ).frame
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
  const initialLegacy = legacy[0]
  if (!initialLegacy || initialLegacy.type !== 'snapshot') {
    throw new Error('missing snapshot')
  }
  const {
    queuedMessages: _list,
    queuePause: _pause,
    nextQueuedMessageId: _next,
    ...base
  } = initialLegacy
  expect(JSON.stringify(initialLegacy)).toBe(
    JSON.stringify({
      ...base,
      queuedMessages: publication.queuedMessages,
      queuePause: publication.queuePause,
      nextQueuedMessageId: publication.nextQueuedMessageId
    })
  )
  const list = vi.spyOn(JournalQueuedMessages.prototype, 'list')
  // Disconnect the legacy reader before asserting the paged path does not hydrate.
  registry.close(PAGE_SESSION, 'legacy')
  rig.journal.observeCommits(() => registry.publish(PAGE_SESSION, rig.journal))
  await rig.insert('second')
  expect(summary(paged.at(-1))?.total).toBe(2)
  const count = paged.length
  registry.publish(PAGE_SESSION, rig.journal)
  expect(paged).toHaveLength(count)
  registry.open({
    id: 'reset',
    sessionId: PAGE_SESSION,
    journal: rig.journal,
    fence: 1,
    queueView: 'paged-v1',
    cursor: { epoch: 'retired', sequence: 0 },
    emit: (frame) => {
      expect(frame.type).toBe('reset')
      expect(summary(frame)?.total).toBe(2)
    }
  })
  expect(list).not.toHaveBeenCalled()
})

it('registers before the initial queue read and observes an insert issued during attach', async () => {
  const frames: AgentSessionSubscribeEvent[] = []
  let registry: AgentSessionSubscribers
  let insert: Promise<unknown> | undefined
  registry = new AgentSessionSubscribers({
    readQueuePublication: () => {
      expect(registry.subscriberCountForTests(PAGE_SESSION)).toBe(1)
      insert ??= rig.insert('concurrent')
      return readQueueSummary(rig.journal, PAGE_GATE)
    }
  })
  rig.journal.observeCommits(() => registry.publish(PAGE_SESSION, rig.journal))
  registry.open({
    id: 'paged',
    sessionId: PAGE_SESSION,
    journal: rig.journal,
    fence: 1,
    queueView: 'paged-v1',
    emit: (event) => frames.push(event)
  })
  await insert
  expect(summary(frames.at(-1))?.total).toBe(1)
})

it('coalesces mutations while output is blocked, keeps the newest revision, and owes nothing after detach', async () => {
  const frames: AgentSessionSubscribeEvent[] = []
  let ready: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    ready = resolve
  })
  const registry = subscribers()
  rig.journal.observeCommits(() => registry.publish(PAGE_SESSION, rig.journal))
  registry.open({
    id: 'paged',
    sessionId: PAGE_SESSION,
    journal: rig.journal,
    fence: 1,
    queueView: 'paged-v1',
    emit: (event) => {
      frames.push(event)
      if (frames.length === 1) {
        return blocked
      }
      return undefined
    }
  })
  const revision = summary(frames[0])?.revision ?? 0
  await rig.insert('one')
  await rig.insert('two')
  await rig.insert('three')
  expect(frames).toHaveLength(1)
  ready?.()
  await blocked
  await Promise.resolve()
  expect(frames).toHaveLength(2)
  expect(summary(frames[1])?.total).toBe(3)
  expect(summary(frames[1])?.revision).toBeGreaterThan(revision)
  registry.close(PAGE_SESSION, 'paged')
  await rig.insert('four')
  expect(frames).toHaveLength(3)
  expect(frames[2]).toEqual({ type: 'end' })
})

it('coalesces multi-page journal catch-up without advancing past an unsent batch', async () => {
  for (let index = 0; index < 210; index++) {
    await rig.journal.appendItem(
      { provider: 'claude', sessionId: 'native', uuid: `row-${index}` },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'row' }] },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  }
  const frames: AgentSessionSubscribeEvent[] = []
  let ready: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    ready = resolve
  })
  subscribers().open({
    id: 'paged',
    sessionId: PAGE_SESSION,
    journal: rig.journal,
    fence: 1,
    queueView: 'paged-v1',
    cursor: { epoch: rig.journal.epoch, sequence: 0 },
    emit: (event) => {
      frames.push(event)
      if (frames.length === 1) {
        return blocked
      }
      return undefined
    }
  })
  expect(frames).toHaveLength(1)
  ready?.()
  await blocked
  await Promise.resolve()
  const ids = frames.flatMap((frame) =>
    frame.type === 'batch' ? frame.batch.items.map((item) => item.itemId) : []
  )
  expect(new Set(ids).size).toBe(210)
  expect(summary(frames.at(-1))?.total).toBe(0)
})

it('replays a coalesced snapshot only to the subscriber whose output was blocked', async () => {
  const blockedFrames: AgentSessionSubscribeEvent[] = []
  const readyFrames: AgentSessionSubscribeEvent[] = []
  let ready: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    ready = resolve
  })
  const registry = subscribers()
  registry.open({
    id: 'blocked',
    sessionId: PAGE_SESSION,
    journal: rig.journal,
    fence: 1,
    queueView: 'paged-v1',
    emit: (frame) => {
      blockedFrames.push(frame)
      if (blockedFrames.length === 1) {
        return blocked
      }
      return undefined
    }
  })
  registry.open({
    id: 'ready',
    sessionId: PAGE_SESSION,
    journal: rig.journal,
    fence: 1,
    queueView: 'paged-v1',
    emit: (frame) => {
      readyFrames.push(frame)
    }
  })
  await rig.insert('newest')
  registry.snapshot(PAGE_SESSION, rig.journal, 2)
  expect(blockedFrames).toHaveLength(1)
  expect(readyFrames).toHaveLength(2)
  ready?.()
  await blocked
  await Promise.resolve()
  expect(blockedFrames).toHaveLength(2)
  expect(blockedFrames[1]).toMatchObject({ type: 'snapshot', fence: 2 })
  expect(summary(blockedFrames[1])?.total).toBe(1)
  expect(readyFrames).toHaveLength(2)
})

it('re-derives a blocked reader from the execution host after journal eviction', async () => {
  const frames: AgentSessionSubscribeEvent[] = []
  let ready: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    ready = resolve
  })
  const readJournal = vi.fn(async () => rig.journal)
  const registry = new AgentSessionSubscribers({
    readJournal,
    readQueuePublication: () => readQueueSummary(rig.journal, PAGE_GATE)
  })
  registry.open({
    id: 'paged',
    sessionId: PAGE_SESSION,
    journal: rig.journal,
    fence: 1,
    queueView: 'paged-v1',
    emit: (frame) => {
      frames.push(frame)
      if (frames.length === 1) {
        return blocked
      }
      return undefined
    }
  })
  const generation = summary(frames[0])?.generation
  await rig.insert('new')
  registry.publish(PAGE_SESSION, rig.journal)
  await rig.reopen()
  ready?.()
  await vi.waitFor(() => expect(frames).toHaveLength(2))
  expect(readJournal).toHaveBeenCalledWith(PAGE_SESSION)
  expect(summary(frames[1])?.total).toBe(1)
  expect(summary(frames[1])?.generation).not.toBe(generation)
})
