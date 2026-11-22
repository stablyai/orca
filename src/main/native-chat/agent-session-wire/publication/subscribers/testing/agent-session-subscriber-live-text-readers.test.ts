import { expect, it } from 'vitest'
import { sessionLiveTextReaders } from '../agent-session-subscriber-live-text-readers'
import { publishSubscriberLiveText } from '../agent-session-subscriber-live-text'
import type { SubscriberDeliveryPort } from '../agent-session-subscriber-catch-up'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal } from '../../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from '../agent-session-subscribe-input'

const subscriber = (fields: Partial<Subscriber>): Subscriber =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the readers read only these fields.
  ({ id: 'reader', sessionId: 'session', ...fields }) as Subscriber

it('still reads a row an older reader takes, beside a shown phone that no longer takes it', () => {
  const phone = subscriber({
    id: 'phone',
    liveTextViewer: 'phone',
    liveTextShown: true,
    holdsTextBase: () => true,
    liveShortened: new Set(['reply'])
  })
  const olderDesktop = subscriber({ id: 'desktop' })
  const readers = sessionLiveTextReaders(
    new Map([
      ['phone', phone],
      ['desktop', olderDesktop]
    ])
  )
  // The phone's group skips the row; the older desktop's group, which takes whole rows, does not.
  expect(readers?.groups?.map((group) => [group.shown, group.takes?.('reply')])).toEqual([
    [true, false],
    [false, undefined]
  ])
  const phoneOnly = sessionLiveTextReaders(new Map([['phone', phone]]))
  expect(phoneOnly?.takes?.('reply')).toBe(false)
})

it('skips a row a reader was sent but can no longer append to, until its save gives the base back', () => {
  let holdsBase = false
  const phone = subscriber({
    id: 'phone',
    liveTextViewer: 'phone',
    liveTextShown: true,
    holdsTextBase: () => holdsBase,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the key is read.
    liveSent: new Map([['reply', {} as never]])
  })
  const readers = sessionLiveTextReaders(new Map([['phone', phone]]))
  expect(readers?.takes?.('reply')).toBe(false)
  expect(readers?.takes?.('other')).toBe(true)
  holdsBase = true
  expect(readers?.takes?.('reply')).toBe(true)
})

it('does not send a row whole again while it waits for its save to restore its append base', async () => {
  const cursor = { epoch: 'e', sequence: 5 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publication reads only the cursor.
  const journal = { cursor: () => cursor } as unknown as SqlAgentSessionJournal
  const bases = new Set(['kept'])
  const sent: string[][] = []
  const reader = subscriber({ cursor, boundedFrames: false, holdsTextBase: (id) => bases.has(id) })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publication uses only hooks and emit.
  const port = {
    hooks: {},
    emit: async (_target: unknown, event: AgentSessionSubscribeEvent) => {
      sent.push(event.type === 'batch' ? event.batch.items.map((item) => item.itemId) : [])
    }
  } as unknown as SubscriberDeliveryPort
  const live = (id: string, text: string): AgentJournalRenderItem => ({
    itemId: id,
    revision: 1,
    sequence: 5,
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  })
  const publish = (items: AgentJournalRenderItem[]) =>
    publishSubscriberLiveText(port, {
      sessionId: 'session',
      journal,
      fence: 1,
      items,
      subscribers: [reader],
      hostNow: 0
    })
  await publish([live('kept', 'a'), live('evicted', 'b')])
  // The second row's base is gone: the readers skip it, and the next windows carry only the first.
  expect(sessionLiveTextReaders(new Map([['reader', reader]]))?.takes?.('evicted')).toBe(false)
  await publish([live('kept', 'aa')])
  await publish([live('kept', 'aaa')])
  expect(sent.slice(1)).toEqual([['kept'], ['kept']])
  expect(sessionLiveTextReaders(new Map([['reader', reader]]))?.takes?.('evicted')).toBe(false)
})
