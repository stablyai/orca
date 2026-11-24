import { expect, it } from 'vitest'
import { claudeSourceBlockIndex, claudeSourceBlockId } from './claude-streamed-block-identity'

const SESSION = '00000000-0000-4000-8000-000000000001'

// Claude Code 2.0.42 writes one row per content block and leaves off apiBlockIndex.
function legacyRow(
  uuid: string,
  parentUuid: string | null,
  messageId: string,
  content: Record<string, unknown>[]
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    session_id: SESSION,
    sessionId: SESSION,
    message: { id: messageId, role: 'assistant', content }
  }
}

it('reads apiBlockIndex when the row carries one', () => {
  const chain = [legacyRow('u-text', null, 'msg_X', [{ type: 'text' }])]
  expect(claudeSourceBlockIndex({ ...chain[0], apiBlockIndex: 3 }, chain)).toBe(3)
})

it('numbers the text row between a thinking row and a parent it does not carry', () => {
  // 2.0.x fixture rows: the text row's parent points at the thinking row, whose parent is the prompt.
  const thinking = legacyRow('u-thinking', 'u-prompt', 'msg_X', [{ type: 'thinking' }])
  const text = legacyRow('u-text', 'u-thinking', 'msg_X', [{ type: 'text' }])
  const chain = [thinking, text]
  expect(claudeSourceBlockIndex(text, chain)).toBe(1)
  expect(claudeSourceBlockId('msg_X', claudeSourceBlockIndex(text, chain)!)).toBe('block:msg_X:1')
})

it('counts rows of the same message only, not neighbours in the chain', () => {
  const chain = [
    legacyRow('u-earlier', 'u-prompt', 'msg_W', [{ type: 'text' }]),
    legacyRow('u-thinking', 'u-earlier', 'msg_X', [{ type: 'thinking' }]),
    legacyRow('u-text', 'u-thinking', 'msg_X', [{ type: 'text' }])
  ]
  expect(claudeSourceBlockIndex(chain[2]!, chain)).toBe(1)
})

it('leaves a row with no message id unresolved', () => {
  const chain = [{ type: 'assistant', uuid: 'u-1', session_id: SESSION, message: {} }]
  expect(claudeSourceBlockIndex(chain[0]!, chain)).toBeNull()
})

it('leaves a row outside the chain unresolved', () => {
  const chain = [legacyRow('u-thinking', null, 'msg_X', [{ type: 'thinking' }])]
  expect(
    claudeSourceBlockIndex(legacyRow('u-elsewhere', null, 'msg_X', [{ type: 'text' }]), chain)
  ).toBeNull()
})
