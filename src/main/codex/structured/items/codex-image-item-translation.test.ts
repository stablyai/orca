import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import {
  nativeChatTurnFold,
  nativeChatTurnFoldRow
} from '../../../../shared/native-chat/transcript/native-chat-turn-fold'
import { codexImageItemBody } from './codex-image-item-translation'

function row(id: string, role: NativeChatMessage['role'], blocks: NativeChatMessage['blocks']) {
  const message: NativeChatMessage = { id, role, blocks, timestamp: 1, source: 'transcript' }
  return nativeChatTurnFoldRow(message, 'turn-1', false)
}

function settledFold(imageItem: Record<string, unknown>): number[] {
  const image = codexImageItemBody({ id: 'image', ...imageItem, type: String(imageItem.type) })
  if (image.kind !== 'message') {
    throw new Error('expected a message row')
  }
  const rows = [
    row('prompt', 'user', [{ type: 'text', text: 'Generate an elephant image' }]),
    row('image', 'assistant', image.blocks),
    row('answer', 'assistant', [{ type: 'text', text: 'Generated a realistic elephant.' }])
  ]
  const fold = nativeChatTurnFold({
    rows,
    settledTurnKeys: new Set(['turn-1']),
    expandedTurnKeys: new Set()
  })
  return [...fold.foldedRows]
}

describe('Codex image rows in a settled turn', () => {
  it('keeps a generated image visible beside the answer', () => {
    expect(
      settledFold({
        type: 'imageGeneration',
        status: 'completed',
        savedPath: 'C:\\Users\\me\\.codex\\generated_images\\thread\\exec-1.png'
      })
    ).toEqual([])
  })

  it('folds an image the agent only viewed', () => {
    expect(settledFold({ type: 'imageView', path: '/tmp/screenshot.png' })).toEqual([1])
  })
})
