import { describe, expect, it } from 'vitest'
import { foldToolMessages } from '../../shared/native-chat/tools/native-chat-tool-fold'
import { nativeChatToolRunViewedImages } from '../../shared/native-chat/tools/native-chat-tool-viewed-images'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

// Claude 2.x Read of an image: the result holds only base64, the path is on the call.
function readTurn(filePath: string, result: Record<string, unknown>): string[] {
  return [
    JSON.stringify({
      type: 'assistant',
      uuid: 'call-row',
      timestamp: '2026-10-29T14:09:20.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: filePath } }]
      }
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'result-row',
      timestamp: '2026-10-29T14:09:23.939Z',
      message: {
        role: 'user',
        content: [{ tool_use_id: 'toolu_1', type: 'tool_result', ...result }]
      },
      toolUseResult: { type: 'image', file: { base64: 'iVBORw0KGgo=', type: 'image/png' } }
    })
  ]
}

const IMAGE_RESULT = {
  content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
  ]
}

function viewedImages(lines: string[]): ReturnType<typeof nativeChatToolRunViewedImages> {
  const decoded = lines
    .map((line, index) => decodeClaudeTranscriptLine(line, `fallback-${index}`))
    .filter((message): message is NativeChatMessage => message !== null)
  const folded = foldToolMessages(decoded)
  expect(folded).toHaveLength(1)
  return nativeChatToolRunViewedImages(folded[0]!.blocks)
}

describe('Claude Read of an image', () => {
  it('shows the screenshot the agent read', () => {
    expect(viewedImages(readTurn('/tmp/orca-annot/s2.png', IMAGE_RESULT))).toEqual([
      { type: 'image-ref', path: '/tmp/orca-annot/s2.png' }
    ])
  })

  it('shows nothing for a read that failed or returned text', () => {
    const failed = { content: 'File does not exist.', is_error: true }
    expect(viewedImages(readTurn('/tmp/gone.png', failed))).toEqual([])
    expect(viewedImages(readTurn('/repo/src/a.ts', { content: '1\tconst a = 1' }))).toEqual([])
    expect(viewedImages(readTurn('/repo/icons/logo.svg', { content: '1\t<svg/>' }))).toEqual([])
  })
})

it('shows nothing for a shell read, which gave the agent bytes as text', () => {
  const codexCat = {
    type: 'tool-call',
    name: 'read',
    callId: 'c1',
    input: { command: 'cat /repo/images/shot.png', cwd: '/repo', path: '/repo/images/shot.png' }
  } as const
  expect(
    nativeChatToolRunViewedImages([codexCat, { type: 'tool-result', callId: 'c1', output: '' }])
  ).toEqual([])
})
