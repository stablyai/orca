import { describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { sanitizeNativeChatRpcBlock } from './native-chat-rpc-block-sanitize'

const SHARED_HEAD = 'a'.repeat(512)

function rosterBlock(ids: readonly string[]): NativeChatBlock {
  return {
    type: 'subagent-group',
    groupId: 'group-1',
    agents: ids.map((id) => ({ id, label: 'l'.repeat(900), state: 'working' as const }))
  }
}

describe('mobile subagent roster bounds', () => {
  it('keeps two ids sharing a 512-char prefix distinct', () => {
    const block = sanitizeNativeChatRpcBlock(
      rosterBlock([`${SHARED_HEAD}-one`, `${SHARED_HEAD}-two`]),
      'mobile'
    )

    if (block.type !== 'subagent-group') {
      throw new Error('expected a subagent-group block')
    }
    expect(block.agents[0]?.id).not.toBe(block.agents[1]?.id)
    expect(block.agents[0]?.id).toHaveLength(512)
    // The label is display text and still clips.
    expect(block.agents[0]?.label).toContain('… (truncated)')
  })

  it('leaves a short id alone', () => {
    const block = sanitizeNativeChatRpcBlock(rosterBlock(['task-1']), 'mobile')
    expect(block.type === 'subagent-group' && block.agents[0]?.id).toBe('task-1')
  })
})
