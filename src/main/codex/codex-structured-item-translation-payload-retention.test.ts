import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setDefaultJournalPayloadRetention,
  type JournalPayloadRetention
} from '../native-chat/agent-session-journal/journal-payload-store'
import {
  codexItemBody,
  codexStreamingJournalItem,
  type CodexThreadItem
} from './codex-structured-item-translation'

// None of these bodies carry a `clipped` or `providerFrame` reference the
// reader admits (journal-payload-reference.ts), so retaining the complete
// original here would write bytes under a digest no read path can ever name.
describe('codex sites that clip text without minting a reference', () => {
  const longText = 'x'.repeat(20_000)
  const fakeRetention = (): JournalPayloadRetention => ({
    retain: vi.fn(() => true),
    retrieve: vi.fn(() => null),
    retrieveRange: vi.fn(() => null),
    isReferencedBy: vi.fn(() => false)
  })
  afterEach(() => setDefaultJournalPayloadRetention(null))

  const nonStreamingCases: [string, CodexThreadItem][] = [
    ['agentMessage flat text', { type: 'agentMessage', id: 'm', text: longText }],
    [
      'userMessage content-part text',
      { type: 'userMessage', id: 'm', content: [{ type: 'text', text: longText }] }
    ],
    ['plan item', { type: 'plan', id: 'p', text: longText }],
    ['reasoning item', { type: 'reasoning', id: 'r', text: longText }]
  ]
  it.each(nonStreamingCases)('does not retain the original for a %s', (_name, item) => {
    const retention = fakeRetention()
    setDefaultJournalPayloadRetention(retention)
    expect(codexItemBody(item)).not.toBeNull()
    expect(retention.retain).not.toHaveBeenCalled()
  })

  const streamingCases: [string, CodexThreadItem][] = [
    ['streaming agentMessage', { type: 'agentMessage', id: 'm' }],
    ['streaming plan', { type: 'plan', id: 'p' }],
    ['streaming reasoning', { type: 'reasoning', id: 'r' }],
    ['streaming fallback status', { type: 'sleep', id: 's', durationMs: 1 }]
  ]
  it.each(streamingCases)('does not retain the original for a %s snapshot', (_name, item) => {
    const retention = fakeRetention()
    setDefaultJournalPayloadRetention(retention)
    expect(codexStreamingJournalItem(item, longText).body).not.toBeNull()
    expect(retention.retain).not.toHaveBeenCalled()
  })

  it('still retains tool-call output and a diff patch, which the reader does admit', () => {
    const retention = fakeRetention()
    setDefaultJournalPayloadRetention(retention)
    const command = codexItemBody({
      type: 'commandExecution',
      id: 'c',
      command: 'cat big.log',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: longText
    })
    expect(command).toMatchObject({ kind: 'tool-call' })
    expect(retention.retain).toHaveBeenCalledTimes(1)
    const fileChangeItem: CodexThreadItem = {
      type: 'fileChange',
      id: 'f',
      changes: [{ path: 'a.ts', diff: 'stub' }]
    }
    expect(codexStreamingJournalItem(fileChangeItem, longText).body).toMatchObject({ kind: 'diff' })
    expect(retention.retain).toHaveBeenCalledTimes(2)
  })
})
