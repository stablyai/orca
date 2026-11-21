import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { StructuredAgentSessionLiveTextRows } from './structured-agent-session-live-text-rows'

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
