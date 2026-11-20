import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { sendingTextAppends } from '../../../../../../shared/agent-session/view/live-read/agent-session-text-append'
import type { SqlAgentSessionJournal } from '../../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from '../agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from '../agent-session-subscriber-catch-up'
import { publishSubscriberLiveText } from '../agent-session-subscriber-live-text'
import type * as WireForm from '../../history/agent-session-item-wire-form'

const wireForms = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../history/agent-session-item-wire-form', async (importOriginal) => {
  const actual = await importOriginal<typeof WireForm>()
  return {
    ...actual,
    agentJournalItemForWire: (item: AgentJournalRenderItem) => {
      wireForms.calls += 1
      return actual.agentJournalItemForWire(item)
    }
  }
})

const cursor = { epoch: 'e', sequence: 5 }
const journal = { cursor: () => cursor } as unknown as SqlAgentSessionJournal
const reply = (text: string): AgentJournalRenderItem => ({
  itemId: 'reply',
  revision: 1,
  sequence: 5,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
})

function stream(boundedFrames: boolean, holdsTextBase?: () => boolean) {
  const events: AgentSessionSubscribeEvent[] = []
  const subscriber = {
    id: 'reader',
    sessionId: 's',
    cursor,
    boundedFrames,
    ...(holdsTextBase ? { holdsTextBase } : {})
  } as unknown as Subscriber
  const port = {
    hooks: {},
    emit: async (_subscriber: Subscriber, event: AgentSessionSubscribeEvent) => {
      events.push(event)
    }
  } as unknown as SubscriberDeliveryPort
  const publish = (text: string): Promise<void> =>
    publishSubscriberLiveText(port, {
      sessionId: 's',
      journal,
      fence: 1,
      items: [reply(text)],
      subscribers: [subscriber],
      hostNow: 0
    })
  return { events, publish }
}

describe('a live reply that only grows', () => {
  for (const [reader, boundedFrames] of [
    ['desktop', false],
    ['phone', true]
  ] as const) {
    for (const size of [128 * 1024, 4 * 1024 * 1024]) {
      it(`is not formed again each window (${reader}, ${size} bytes)`, async () => {
        const { publish } = stream(boundedFrames)
        let text = 'a'.repeat(size)
        await publish(text)
        wireForms.calls = 0
        for (let window = 0; window < 10; window++) {
          text += ' more words'
          await publish(text)
        }
        expect(wireForms.calls).toBe(0)
      })
    }
  }

  it('goes nowhere until the reader holds its text to append to', async () => {
    const { events, publish } = stream(false, () => false)
    await publish('a'.repeat(1024))
    expect(events).toEqual([])
  })

  it('reaches an append reader as only its new text', async () => {
    const wire: AgentSessionSubscribeEvent[] = []
    const send = sendingTextAppends((event: AgentSessionSubscribeEvent) => wire.push(event), {})
    const seed = reply('a'.repeat(64 * 1024))
    send({
      type: 'batch',
      sessionId: 's',
      fence: 1,
      hostNow: 0,
      batch: { cursor, items: [seed], removedItemIds: [], submissions: [] }
    })
    const { events, publish } = stream(false, () => send.holdsBase('reply'))
    await publish(`${'a'.repeat(64 * 1024)} next`)
    events.forEach(send)
    const delta = JSON.stringify(wire.at(-1)).length
    expect(delta).toBeLessThan(1024)
  })
})
