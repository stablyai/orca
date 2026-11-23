import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { mobileNativeChatPromptAbove } from './mobile-native-chat-prompt-above'

function prompt(id: string, fields?: Partial<NativeChatMessage>): NativeChatMessage {
  return {
    id,
    role: 'user',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'A question' }],
    ...fields
  }
}

describe('mobileNativeChatPromptAbove', () => {
  it('steps to the newest prompt above the drawn window', () => {
    const rows = [prompt('first'), prompt('undrawn'), prompt('visible')]
    expect(mobileNativeChatPromptAbove(rows, ['first', 'undrawn', 'visible'], 2, () => 20)).toEqual(
      {
        key: 'undrawn',
        index: 1
      }
    )
  })

  it('steps past a prompt already aligned within eight pixels of the top', () => {
    const rows = [prompt('earlier'), prompt('almost-aligned')]
    expect(
      mobileNativeChatPromptAbove(rows, ['earlier', 'almost-aligned'], 0, (key) =>
        key === 'earlier' ? -72 : -8
      )
    ).toEqual({ key: 'earlier', index: 0 })
  })

  it('returns no target when the first prompt is at the top', () => {
    expect(mobileNativeChatPromptAbove([prompt('at-top')], ['at-top'], 0, () => 0)).toEqual(
      undefined
    )
  })

  it('passes over queued sends, agent mail and tool-only user rows', () => {
    const rows = [
      prompt('human'),
      prompt('queued', { queued: true }),
      prompt('agent-mail', { from: { kind: 'agent', senders: [], orchestration: null } }),
      prompt('tool-output', { blocks: [{ type: 'tool-result', output: 'done' }] })
    ]
    expect(
      mobileNativeChatPromptAbove(
        rows,
        ['human', 'queued', 'agent-mail', 'tool-output'],
        0,
        () => -70
      )
    ).toEqual({ key: 'human', index: 0 })
  })
})
