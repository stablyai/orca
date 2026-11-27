import { describe, expect, it } from 'vitest'
import { claudeContentBlocks } from './transcript-record-blocks'

describe('claudeContentBlocks', () => {
  it('keeps text indentation and tool output edges, dropping text edge blank lines', () => {
    expect(
      claudeContentBlocks([
        { type: 'text', text: '\n \n    indented()\n' },
        { type: 'thinking', thinking: '\tplan\n\n' },
        { type: 'text', text: ' \n\t ' },
        {
          type: 'tool_result',
          tool_use_id: 'read',
          content: [
            { type: 'text', text: '  1\tx\n' },
            { type: 'text', text: '  2\ty' }
          ]
        }
      ])
    ).toEqual([
      { type: 'text', text: '    indented()' },
      { type: 'text', text: '\tplan' },
      { type: 'tool-result', callId: 'read', output: '  1\tx\n  2\ty' }
    ])
  })
})
