import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { textExtends } from '../../../../shared/agent-session/view/live-read/agent-session-text-append'
import { createAgentSessionDeltaCoalescer } from '../publication/subscribers/agent-session-delta-coalescer'
import { StructuredAgentSessionLiveTextRows } from './structured-agent-session-live-text-rows'

const textOf = (item: AgentJournalRenderItem): string =>
  item.body.kind === 'message' && item.body.blocks[0]?.type === 'text'
    ? item.body.blocks[0].text
    : ''

it('offers no reply too long for a viewer to hold twice, so its stream is never ended for it', () => {
  let read: ((epoch: string) => readonly AgentJournalRenderItem[]) | undefined
  const texts = new Map([
    ['short', 'a few words'],
    ['huge', 'x'.repeat(4 * 1024 * 1024)]
  ])
  const rows = new StructuredAgentSessionLiveTextRows(
    {
      bindLiveText: (source) => {
        read = source.read
        return () => {}
      }
    },
    (key, maxLength) => {
      const text = texts.get(key)
      return text !== undefined && text.length <= maxLength ? text : undefined
    },
    (_key, text) => ({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] })
  )
  for (const key of texts.keys()) {
    rows.committed(key)(
      {
        itemId: key,
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'assistant', blocks: [] }
      },
      'e'
    )
  }
  expect(read?.('e').map((item) => item.itemId)).toEqual(['short'])
})

it('never tells a reader a truncated reply extends the text it holds', () => {
  let read: ((epoch: string) => readonly AgentJournalRenderItem[]) | undefined
  // A budget the next delta overflows, so the stream is cut and its tail becomes the marker.
  const coalescer = createAgentSessionDeltaCoalescer({
    emit: () => true,
    schedule: () => () => {},
    maxRetainedBytes: 1_002
  })
  const rows = new StructuredAgentSessionLiveTextRows(
    {
      bindLiveText: (source) => {
        read = source.read
        return () => {}
      }
    },
    coalescer.textWithin,
    (_key, text) => ({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }),
    coalescer.streamOf
  )
  rows.committed('reply')(
    {
      itemId: 'reply',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'assistant', blocks: [] }
    },
    'e'
  )
  coalescer.append('reply', 'x'.repeat(1_000))
  const held = read!('e')[0]!
  const heldText = textOf(held)
  coalescer.append('reply', 'yyy')
  const cut = read!('e')[0]!
  const cutText = textOf(cut)
  expect(cutText.startsWith(heldText)).toBe(false)
  expect(textExtends(cut, cutText, heldText)).toBe(false)
})

it('shows a recreated truncated reply, not the old row of the same length', () => {
  let read: ((epoch: string) => readonly AgentJournalRenderItem[]) | undefined
  const coalescer = createAgentSessionDeltaCoalescer({
    emit: () => true,
    schedule: () => () => {},
    maxRetainedBytes: 1_002
  })
  const rows = new StructuredAgentSessionLiveTextRows(
    {
      bindLiveText: (source) => {
        read = source.read
        return () => {}
      }
    },
    coalescer.textWithin,
    (_key, text) => ({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }),
    coalescer.streamOf
  )
  rows.committed('reply')(
    {
      itemId: 'reply',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'assistant', blocks: [] }
    },
    'e'
  )
  coalescer.append('reply', 'x'.repeat(1_003))
  const first = textOf(read!('e')[0]!)
  // The stream goes and a new one under the same key is cut to the same length.
  coalescer.forget('reply')
  coalescer.append('reply', 'z'.repeat(1_003))
  const second = textOf(read!('e')[0]!)
  expect(second.length).toBe(first.length)
  expect(second).not.toBe(first)
  expect(second.startsWith('z')).toBe(true)
})
