import { describe, expect, it } from 'vitest'

import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

// Claude 2.1.237 stores source paths in separate isMeta/turnCompanion rows; prompt base64 has no path.

describe('Claude pasted-image companion row', () => {
  it('still drops an ordinary isMeta injected turn', () => {
    const injected = JSON.stringify({
      type: 'user',
      uuid: 'injected',
      isMeta: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Base directory for this skill: /x' }]
      }
    })
    expect(decodeClaudeTranscriptLine(injected, 'fallback')).toBeNull()
  })

  it('does not turn a mixed marker-and-prose meta row into an image source turn', () => {
    const mixed = JSON.stringify({
      type: 'user',
      uuid: 'mixed',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image: source: /tmp/a.png]' },
          { type: 'text', text: 'metadata prose' }
        ]
      }
    })

    expect(decodeClaudeTranscriptLine(mixed, 'fallback')).toBeNull()
  })

  it('retains tool results from a mixed meta row while dropping its marker text', () => {
    const mixed = JSON.stringify({
      type: 'user',
      uuid: 'mixed-tool',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image: source: /tmp/a.png]' },
          { type: 'tool_result', content: 'tool output' }
        ]
      }
    })

    expect(decodeClaudeTranscriptLine(mixed, 'fallback')).toMatchObject({
      id: 'mixed-tool',
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'tool output' }]
    })
  })
})
