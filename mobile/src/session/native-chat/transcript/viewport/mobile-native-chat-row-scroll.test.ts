import { expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { mobileNativeChatTurnStartTarget } from './mobile-native-chat-row-scroll'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

const status = { startedAt: 1, thinking: false, workedSeconds: 14 }
const rows: NativeChatMessage[] = ['old', 'prompt', 'tools', 'reply'].map((id) => ({
  id,
  role: id === 'prompt' ? 'user' : 'assistant',
  blocks: [],
  timestamp: null,
  source: 'transcript'
}))

it('lands on the turn bar below the prompt, with a margin above it', () => {
  const turn = (index: number) =>
    index === 1 ? { turnStatus: status, opensTurn: true as const } : { turnStatus: null }
  expect(mobileNativeChatTurnStartTarget(rows, 3, turn, true)).toEqual({ index: 2, viewOffset: 40 })
})

it('lands on a bar drawn above the turn, which only the page draws outside the row', () => {
  const turn = (index: number) =>
    index === 2 ? { turnStatus: status, turnStatusAbove: true } : { turnStatus: null }
  expect(mobileNativeChatTurnStartTarget(rows, 3, turn, true)).toEqual({ index: 2, viewOffset: 12 })
  expect(mobileNativeChatTurnStartTarget(rows, 3, turn, false)).toEqual({
    index: 2,
    viewOffset: 40
  })
})

it('lands on the reply when its turn has no bar and no prompt', () => {
  expect(mobileNativeChatTurnStartTarget(rows, 3, () => ({ turnStatus: null }), true)).toEqual({
    index: 3,
    viewOffset: 12
  })
})
