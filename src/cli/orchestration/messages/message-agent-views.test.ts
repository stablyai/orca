import { describe, expect, it } from 'vitest'
import { checkView } from './message-agent-views'

describe('orchestration check text', () => {
  it("ends a finished item worker's report with its item line", () => {
    const view = checkView('term_bot')
    const result = {
      count: 1,
      messages: [
        {
          id: 'msg_1',
          type: 'worker_done',
          from_handle: 'dispatch:ctx_1',
          subject: 'Done',
          follow_up: { kind: 'send' as const, dispatchId: 'ctx_1', active: false },
          for_item: {
            number: 34,
            title: 'Paste images',
            status: 'planned' as const,
            doneMeans: null
          }
        }
      ]
    }
    const lines = view.text!(view.fields(result), result).split('\n')
    expect(lines.at(-1)).toMatch(
      /^\[This worker was started for item 34, "Paste images" \(Planned\)\. If this result changes the item, update it with \S+ bot item <cancel\|comment\|done\|set> 34\.\]$/
    )
    expect(lines.at(-2)).toMatch(/^To give this worker more work: /)
  })
})
