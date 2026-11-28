import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { capJournalToolOutput } from './journal-tool-output-cap'

function toolItem(head: string): AgentJournalRenderItem {
  const item = {
    itemId: 'tool-1',
    revision: 2,
    sequence: 3,
    body: {
      kind: 'tool-call',
      toolName: 'Bash',
      state: 'completed',
      input: {},
      output: { head, byteLength: Buffer.byteLength(head), digest: 'd1', truncated: false }
    }
  }
  return item as unknown as AgentJournalRenderItem
}

describe('capJournalToolOutput', () => {
  it('saves at most 64 KiB of whole characters, start and end kept', () => {
    // Four-byte characters straddle every byte boundary a naive cut would pick.
    const text = `START${'😀'.repeat(40_000)}END`
    const capped = capJournalToolOutput(toolItem(text), undefined)
    const output = capped.body.kind === 'tool-call' ? capped.body.output! : null
    expect(Buffer.byteLength(output!.head)).toBeLessThanOrEqual(64 * 1024)
    expect(output!.head.startsWith('START')).toBe(true)
    expect(output!.head.endsWith('END')).toBe(true)
    expect(output!.head).not.toContain('�')
    expect(output!.truncated).toBe(true)
    expect(output!.byteLength).toBe(Buffer.byteLength(text))
    expect(capJournalToolOutput(capped, undefined)).toBe(capped)
  })

  it('never cuts an output an earlier revision saved whole', () => {
    const whole = toolItem('x'.repeat(200 * 1024))
    expect(capJournalToolOutput(whole, whole)).toBe(whole)
  })
})
