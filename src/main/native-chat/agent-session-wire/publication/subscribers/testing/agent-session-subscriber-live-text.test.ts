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

it('gives a durable row the newer live text of its own revision only', () => {
  const durable = [row('reply', 2, 'saved'), row('other', 1, 'kept')]
  const items = withSubscriberLiveText(
    durable,
    () => [row('reply', 2, 'saved and streamed'), row('other', 0, 'stale')],
    (item) => ({ item, bytes: Buffer.byteLength(JSON.stringify(item)) })
  )
  expect(items).toEqual([row('reply', 2, 'saved and streamed'), row('other', 1, 'kept')])
})
