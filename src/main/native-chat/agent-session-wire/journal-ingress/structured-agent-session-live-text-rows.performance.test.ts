import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { textExtends } from '../../../../shared/agent-session/view/live-read/agent-session-text-append'
import { createAgentSessionDeltaCoalescer } from '../publication/subscribers/agent-session-delta-coalescer'
import { StructuredAgentSessionLiveTextRows } from './structured-agent-session-live-text-rows'

afterEach(() => vi.restoreAllMocks())

const textOf = (item: AgentJournalRenderItem): string =>
  item.body.kind === 'message' && item.body.blocks[0]?.type === 'text'
    ? item.body.blocks[0].text
    : ''

/** Characters `startsWith` compared over 20 live windows of a reply already `length` long. */
function comparedStreaming(length: number): number {
  let read: ((epoch: string) => readonly AgentJournalRenderItem[]) | undefined
  const coalescer = createAgentSessionDeltaCoalescer({
    emit: () => true,
    schedule: () => () => {}
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
  coalescer.append('reply', 'x'.repeat(length))
  let last = read!('e')[0]!
  let compared = 0
  const startsWith = String.prototype.startsWith
  vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
    this: string,
    search: string,
    position?: number
  ) {
    compared += Math.min(this.length, search.length)
    return startsWith.call(this, search, position)
  })
  for (let window = 0; window < 20; window++) {
    coalescer.append('reply', ' more words')
    const next = read!('e')[0]!
    // Each reader's check that the row extends what it holds is answered without a scan.
    expect(textExtends(next, textOf(next), textOf(last))).toBe(true)
    last = next
  }
  return compared
}

// Perf contract: a live window over an append-only stream compares no reply text, so its cost on
// the main process doesn't grow with the reply, at N and 10N characters.
it('compares no reply text per live window, at N and 10N characters', () => {
  expect(comparedStreaming(100_000)).toBe(0)
  expect(comparedStreaming(1_000_000)).toBe(0)
})
