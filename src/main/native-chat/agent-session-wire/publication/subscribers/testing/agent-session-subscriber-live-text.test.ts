import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  sendingTextAppends,
  createAgentSessionTextAppendReader
} from '../../../../../../shared/agent-session/view/live-read/agent-session-text-append'
import { noteAgentSessionTextAppendSource } from '../../../../../../shared/agent-session/view/live-read/agent-session-text-append-source'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import { createAgentSessionDeltaCoalescer } from '../agent-session-delta-coalescer'
import { BOUNDED_FRAME_ROW_BYTES } from '../../history/agent-session-bounded-frame-item'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../../history/agent-session-history-page-bounds'
import { readTestJournalItems } from '../../../../agent-session-journal/journal-observation.test-support'
import { codexProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { journals, fixture } from './structured-agent-session-subscriber-contract.test-fixture'
import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { withSubscriberLiveText } from '../agent-session-subscriber-live-text'

const row = (itemId: string, revision: number, text: string): AgentJournalRenderItem => ({
  itemId,
  revision,
  sequence: 4,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
})

it.each([
  { count: 8, tool: false },
  { count: 9, tool: false },
  { count: 12, tool: false },
  { count: 16, tool: true },
  { count: 17, tool: true }
])(
  'decodes every live frame with $count concurrent replies (tool append=$tool)',
  async ({ count, tool }) => {
    const rules = tool ? { toolOutputAppend: 1 as const } : {}
    const limit = tool ? 16 : 8
    const journal = await journals.open({
      stateDirectory: fixture.root,
      identity: {
        sessionId: 'session',
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread')
      }
    })
    const identities = Array.from({ length: count }, (_, ordinal) => ({
      provider: 'codex' as const,
      threadId: 'thread',
      turnId: 'turn',
      ordinal
    }))
    for (const identity of identities) {
      await journal.appendItem(identity, row('', 1, 'x').body, {
        fence: 1,
        turnScope: { kind: 'thread' }
      })
    }
    let saved = await readTestJournalItems(journal)
    const tokens = saved.map(() => ({}))
    let length = 1
    let cachedLength = -1
    let cached: AgentJournalRenderItem[] = []
    const read = () => {
      if (cachedLength === length) {
        return cached
      }
      cachedLength = length
      cached = saved.map((item, index) => {
        const next = { ...item, body: row('', 1, 'x'.repeat(length)).body }
        noteAgentSessionTextAppendSource(next, {
          identity: tokens[index]!,
          length,
          jsonBytes: length,
          suffix: (from) => 'x'.repeat(length - from)
        })
        return next
      })
      return cached
    }
    const subscribers = new AgentSessionSubscribers({ readLiveText: read })
    const reader = createAgentSessionTextAppendReader(rules)
    const frames: AgentSessionSubscribeEvent[] = []
    let delivered = Promise.withResolvers<void>()
    const send = sendingTextAppends((wire) => {
      expect(reader(wire)).not.toBeNull()
      frames.push(wire)
      delivered.resolve()
    }, rules)
    const close = subscribers.open({
      id: 'client',
      sessionId: 'session',
      journal,
      fence: 1,
      projectLiveItem: send.item,
      hasTextAppendBase: send.hasBase,
      emit: send
    })
    await delivered.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    frames.length = 0
    for (let index = 0; index < 20; index++) {
      length += 200
      delivered = Promise.withResolvers<void>()
      subscribers.publishLiveText('session', journal, 1, read, true)
      await delivered.promise
    }
    expect(frames).toHaveLength(20)
    for (const event of frames) {
      expect(event.type).toBe('batch')
      if (event.type === 'batch') {
        expect(event.batch.items.length).toBe(Math.min(count, limit))
        expect(event.batch.items.every((item) => 'textAppend' in item)).toBe(true)
        expect(JSON.stringify(event).length).toBeLessThan(10000)
      }
    }
    delivered = Promise.withResolvers<void>()
    await journal.appendItem(identities[0]!, row('', 1, 'x'.repeat(length)).body, {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    saved = await readTestJournalItems(journal)
    cachedLength = -1
    subscribers.publish('session', journal)
    await delivered.promise
    expect(send.hasBase(saved[0]!.itemId)).toBe(true)
    length += 1
    delivered = Promise.withResolvers<void>()
    subscribers.publishLiveText('session', journal, 1, read, true)
    await delivered.promise
    // A newly admitted whole row precedes retained bases in source order. Sending it first
    // would evict a base needed by a later suffix in this same frame.
    saved = [{ ...saved[0]!, itemId: 'new-reply' }, ...saved]
    tokens.unshift({})
    length += 1
    delivered = Promise.withResolvers<void>()
    subscribers.publishLiveText('session', journal, 1, read, true)
    await delivered.promise
    const mixed = frames.at(-1)!
    expect(mixed.type).toBe('batch')
    if (mixed.type === 'batch') {
      expect(mixed.batch.items.at(-1)!.itemId).toBe('new-reply')
      expect(mixed.batch.items.slice(0, -1).every((item) => 'textAppend' in item)).toBe(true)
    }
    close()
  }
)

it('gives a durable row the newer live text of its own revision only', () => {
  const durable = [row('reply', 2, 'saved'), row('other', 1, 'kept')]
  const items = withSubscriberLiveText(
    durable,
    () => [row('reply', 2, 'saved and streamed'), row('other', 0, 'stale')],
    (item) => ({ item, bytes: 0 })
  )
  expect(items).toEqual([row('reply', 2, 'saved and streamed'), row('other', 1, 'kept')])
})

it.each([true, false])(
  'never appends past the full-row budget (phone=%s)',
  async (boundedFrames) => {
    const journal = await journals.open({
      stateDirectory: fixture.root,
      identity: {
        sessionId: 'session',
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread')
      }
    })
    const identity = { provider: 'codex' as const, threadId: 'thread', turnId: 'turn', ordinal: 0 }
    const budget = boundedFrames ? BOUNDED_FRAME_ROW_BYTES : HISTORY_PAGE_CONTENT_BUDGET_BYTES
    const coalescer = createAgentSessionDeltaCoalescer({ emit: () => {}, schedule: () => () => {} })
    coalescer.append('reply', 'x'.repeat(budget - 900))
    const body = (text: string) => ({
      kind: 'message' as const,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text }]
    })
    await journal.appendItem(identity, body(coalescer.snapshot('reply')!.text), {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    let saved = (await readTestJournalItems(journal))[0]!
    const read = () => {
      const source = { ...saved, body: body(coalescer.snapshot('reply')!.text) }
      noteAgentSessionTextAppendSource(source, coalescer.textSource('reply')!)
      return [source]
    }
    const subscribers = new AgentSessionSubscribers({ readLiveText: read })
    const decode = createAgentSessionTextAppendReader({})
    let delivered = Promise.withResolvers<AgentSessionSubscribeEvent>()
    const send = sendingTextAppends((wire) => {
      const event = decode(wire)
      expect(event).not.toBeNull()
      delivered.resolve(event!)
    }, {})
    const close = subscribers.open({
      id: 'client',
      sessionId: 'session',
      journal,
      fence: 1,
      boundedFrames,
      projectLiveItem: send.item,
      emit: send
    })
    await delivered.promise
    let shown = ''
    for (const count of [200, 200, 1024]) {
      coalescer.append('reply', 'x'.repeat(count))
      delivered = Promise.withResolvers<AgentSessionSubscribeEvent>()
      subscribers.publishLiveText('session', journal, 1, read)
      const event = await delivered.promise
      expect(event.type).toBe('batch')
      if (event.type === 'batch') {
        const item = event.batch.items[0]!
        expect(item.body.kind).toBe('message')
        const text =
          item.body.kind === 'message' && item.body.blocks[0]?.type === 'text'
            ? item.body.blocks[0].text
            : ''
        expect(text.length).toBeGreaterThanOrEqual(shown.length)
        expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(budget)
        shown = text
      }
    }
    delivered = Promise.withResolvers<AgentSessionSubscribeEvent>()
    await journal.appendItem(identity, body(coalescer.snapshot('reply')!.text), {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    saved = (await readTestJournalItems(journal))[0]!
    subscribers.publish('session', journal)
    const durable = await delivered.promise
    if (durable.type === 'batch') {
      expect(durable.batch.items[0]!.body).toEqual(body(shown))
    }
    close()
    coalescer.dispose()
  }
)
