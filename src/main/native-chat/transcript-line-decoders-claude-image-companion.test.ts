import { describe, expect, it } from 'vitest'
import { normalizeImageTranscriptMessages } from '../../shared/native-chat-image-transcript-markers'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

// Verbatim shape of a pasted-image turn, Claude Code 2.1.237: the prompt row carries
// `[Image #N]` markers plus base64 blocks (no url/path, so they decode to nothing), and
// a SEPARATE companion row marked isMeta/turnCompanion carries one `[Image: source: ]`
// text block per image. A survey of ~/.claude/projects found 238 of 241 image-source
// rows marked isMeta, across every versioned release.
const PROMPT_ROW = JSON.stringify({
  type: 'user',
  uuid: 'prompt-uuid',
  timestamp: '2026-09-01T01:33:04.608Z',
  message: {
    role: 'user',
    content: [
      { type: 'text', text: 'look at this\r[Image #1] [Image #2] does it repro?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }
    ]
  }
})
const COMPANION_ROW = JSON.stringify({
  type: 'user',
  uuid: 'companion-uuid',
  isMeta: true,
  turnCompanion: true,
  timestamp: '2026-09-01T01:33:04.608Z',
  message: {
    role: 'user',
    content: [
      { type: 'text', text: '[Image: source: /tmp/orca-paste-a.png]' },
      { type: 'text', text: '[Image: source: /tmp/orca-paste-b.png]' }
    ]
  }
})

function decode(): NativeChatMessage[] {
  return [COMPANION_ROW, PROMPT_ROW]
    .map((line, index) => decodeClaudeTranscriptLine(line, `fallback-${index}`))
    .filter((message): message is NativeChatMessage => message !== null)
}

describe('Claude pasted-image companion row', () => {
  it('keeps the isMeta companion row so the turn carries its attachments', () => {
    const decoded = decode()
    expect(decoded.map((m) => m.id)).toEqual(['companion-uuid', 'prompt-uuid'])
  })

  it('folds a multi-image companion into the prompt as image refs', () => {
    const folded = normalizeImageTranscriptMessages(decode())
    expect(folded).toHaveLength(1)
    expect(folded[0]!.blocks.filter((b) => b.type === 'image-ref')).toEqual([
      { type: 'image-ref', path: '/tmp/orca-paste-a.png' },
      { type: 'image-ref', path: '/tmp/orca-paste-b.png' }
    ])
    // The caption survives with its markers stripped.
    const text = folded[0]!.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
    expect(text).toContain('look at this')
    expect(text).toContain('does it repro?')
    expect(text).not.toContain('[Image #')
  })

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
