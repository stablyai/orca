import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { claudeContentBlocks } from './transcript-record-blocks'
import { foldToolMessages } from '../../shared/native-chat/tools/native-chat-tool-fold'

// Agent-taken screenshots ride inside tool_result content as Anthropic image
// blocks. The text output still flattens to the tool-result block; each image
// part additionally promotes to an image-ref so chat can render it.
const TOOL_RESULT_WITH_SCREENSHOT = [
  {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: [
      { type: 'text', text: 'screenshot taken' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }
      }
    ]
  }
]

describe('tool_result image promotion', () => {
  it('emits an image-ref alongside the tool-result text', () => {
    expect(claudeContentBlocks(TOOL_RESULT_WITH_SCREENSHOT)).toEqual([
      { type: 'tool-result', callId: 'toolu_1', output: 'screenshot taken' },
      { type: 'image-ref', url: 'data:image/png;base64,iVBORw0KGgo=' }
    ])
  })

  it('drops url-sourced images so chat never fetches an agent-chosen host', () => {
    const blocks = claudeContentBlocks([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        content: [{ type: 'image', source: { type: 'url', url: 'https://x.test/shot.png' } }]
      }
    ])
    expect(blocks).toEqual([{ type: 'tool-result', callId: 'toolu_2', output: '' }])
  })

  it('leaves text-only tool results unchanged', () => {
    expect(
      claudeContentBlocks([{ type: 'tool_result', tool_use_id: 'x', content: 'done' }])
    ).toEqual([{ type: 'tool-result', callId: 'x', output: 'done' }])
  })

  it('drops base64 parts whose mime is not a raster image', () => {
    const blocks = claudeContentBlocks([
      {
        type: 'tool_result',
        tool_use_id: 'x',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' }
          }
        ]
      }
    ])
    expect(blocks).toEqual([{ type: 'tool-result', callId: 'x', output: '' }])
  })

  it('still drops user-prompt base64 images without url/path (companion rows carry them)', () => {
    const blocks = claudeContentBlocks([
      { type: 'text', text: 'look [Image #1]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ])
    expect(blocks).toEqual([{ type: 'text', text: 'look [Image #1]' }])
  })
})

describe('tool_result screenshot records', () => {
  it.each([false, true])(
    'keeps image-only tool output paired with its call with isMeta=%s',
    (isMeta) => {
      const image = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }
      }
      const result = decodeClaudeTranscriptLine(
        JSON.stringify({
          type: 'user',
          uuid: 'image-only',
          isMeta,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'capture', content: [image] }]
          }
        }),
        'fallback'
      )
      if (!result) {
        throw new Error('expected an image-only tool result')
      }
      const folded = foldToolMessages([
        {
          id: 'call',
          role: 'assistant',
          blocks: [{ type: 'tool-call', name: 'screenshot', callId: 'capture', input: {} }],
          timestamp: null,
          source: 'transcript'
        },
        result
      ])

      expect(folded).toMatchObject([
        {
          id: 'call',
          blocks: [
            { type: 'tool-call', callId: 'capture' },
            { type: 'tool-result', callId: 'capture', output: '' }
          ]
        },
        {
          id: 'image-only',
          role: 'tool',
          blocks: [{ type: 'image-ref', url: 'data:image/png;base64,iVBORw0KGgo=' }]
        }
      ])
    }
  )

  it('decode as tool output, not a user bubble', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-09-29T00:00:00.000Z',
      message: { role: 'user', content: TOOL_RESULT_WITH_SCREENSHOT }
    })
    const decoded = decodeClaudeTranscriptLine(line, 'fallback')
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks.map((block) => block.type)).toEqual(['tool-result', 'image-ref'])
  })
})
