import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { sendingTextAppends } from '../../../../../../shared/agent-session/view/live-read/agent-session-text-append'
import type { SqlAgentSessionJournal } from '../../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from '../agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from '../agent-session-subscriber-catch-up'
import {
  noteSubscriberLiveRow,
  publishSubscriberLiveText,
  sessionLiveTextReaders,
  withSubscriberLiveText
} from '../agent-session-subscriber-live-text'
import type * as WireForm from '../../history/agent-session-item-wire-form'
import { StructuredAgentSessionLiveTextRows } from '../../../journal-ingress/structured-agent-session-live-text-rows'

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
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: live publication reads only the journal's cursor.
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: live publication reads only these subscriber fields.
  const subscriber = {
    id: 'reader',
    sessionId: 's',
    cursor,
    boundedFrames,
    liveTextShown: true,
    ...(holdsTextBase ? { holdsTextBase } : {})
  } as unknown as Subscriber
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: live publication uses only the port's hooks and emit.
  const port = {
    hooks: {},
    emit: async (_subscriber: Subscriber, event: AgentSessionSubscribeEvent) => {
      events.push(event)
    }
  } as unknown as SubscriberDeliveryPort
  const publishItems = (items: readonly AgentJournalRenderItem[]): Promise<void> =>
    publishSubscriberLiveText(port, {
      sessionId: 's',
      journal,
      fence: 1,
      items,
      subscribers: [subscriber],
      hostNow: 0
    })
  const publish = (text: string): Promise<void> => publishItems([reply(text)])
  return { events, publish, publishItems, subscriber }
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

  it('never sends text older than the reader was already sent', async () => {
    const { events, publish } = stream(false)
    await publish('one two three')
    await publish('one two')
    expect(events).toHaveLength(1)
  })

  it("goes whole once to a reader without a reply's text, then waits for a base to append to", async () => {
    let text = 'a'.repeat(1024)
    let read: ((epoch: string) => readonly AgentJournalRenderItem[]) | undefined
    const rows = new StructuredAgentSessionLiveTextRows(
      {
        bindLiveText: (source) => {
          read = source.read
          return () => {}
        }
      },
      () => text,
      (_key, next) => reply(next).body
    )
    rows.committed('reply')(reply(''), 'e')
    const { events, publishItems } = stream(false, () => false)
    await publishItems(read?.('e') ?? [])
    text = `${text} more`
    await publishItems(read?.('e') ?? [])
    expect(events).toHaveLength(1)
  })

  it('leaves a streamed reply to its saves for a reader that cannot take appends', async () => {
    let read: ((epoch: string) => readonly AgentJournalRenderItem[]) | undefined
    const rows = new StructuredAgentSessionLiveTextRows(
      {
        bindLiveText: (source) => {
          read = source.read
          return () => {}
        }
      },
      () => 'a'.repeat(1024),
      (_key, text) => reply(text).body
    )
    rows.committed('reply')(reply(''), 'e')
    const { events, publishItems } = stream(true)
    await publishItems(read?.('e') ?? [])
    expect(read?.('e')).toHaveLength(1)
    expect(events).toEqual([])
  })

  it('is no longer read for a phone that was sent it shortened, since its save carries it', async () => {
    let read:
      | ((epoch: string, readers?: { appends: boolean }) => readonly AgentJournalRenderItem[])
      | undefined
    let reads = 0
    const rows = new StructuredAgentSessionLiveTextRows(
      {
        bindLiveText: (source) => {
          read = source.read
          return () => {}
        }
      },
      () => {
        reads += 1
        return 'a'.repeat(128 * 1024)
      },
      (_key, text) => reply(text).body
    )
    rows.committed('reply')(reply(''), 'e')
    const { events, publishItems, subscriber } = stream(true, () => false)
    const readers = () => sessionLiveTextReaders(new Map([['reader', subscriber]])) ?? undefined
    await publishItems(read?.('e', readers()) ?? [])
    reads = 0
    await publishItems(read?.('e', readers()) ?? [])
    expect(events).toHaveLength(1)
    expect(reads).toBe(0)
  })

  it('is no longer read for a phone whose save carried it shortened', () => {
    const { subscriber } = stream(true, () => false)
    const saved = reply('a'.repeat(128 * 1024))
    noteSubscriberLiveRow(subscriber)(saved, { ...saved, shortened: true }, 72 * 1024)
    expect(sessionLiveTextReaders(new Map([['reader', subscriber]]))?.takes?.('reply')).toBe(false)
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

it('keeps a saved row whose live text would take a page past its reply limit', () => {
  const saved = reply('a few words')
  // 2 MiB of text: the page already holds up to half the 4 MiB reply limit.
  const live = reply('x'.repeat(2 * 1024 * 1024))
  const form = (item: AgentJournalRenderItem) => ({ item, bytes: JSON.stringify(item).length })
  expect(withSubscriberLiveText([saved], () => [live], form)).toEqual([saved])
})

it('counts the page submissions against the room live text may take', () => {
  const saved = reply('a few words')
  const live = reply('x'.repeat(256 * 1024))
  const form = (item: AgentJournalRenderItem) => ({ item, bytes: JSON.stringify(item).length })
  const submissions = ['y'.repeat(1900 * 1024)]
  expect(withSubscriberLiveText([saved], () => [live], form, undefined, submissions)).toEqual([
    saved
  ])
})
