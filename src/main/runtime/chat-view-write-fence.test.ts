import { describe, expect, it } from 'vitest'
import { ChatViewWriteFence } from './chat-view-write-fence'

describe('ChatViewWriteFence', () => {
  it('applies newer sequences, answers a resend of a landed write as a duplicate, refuses older ones', () => {
    const fence = new ChatViewWriteFence()
    expect(fence.admit('wt', 'tab', 'W', 2)).toBe('apply')
    fence.confirm('wt', 'tab', 'W', 2)
    expect(fence.admit('wt', 'tab', 'W', 2)).toBe('duplicate')
    expect(fence.admit('wt', 'tab', 'W', 1)).toBe('superseded')
    expect(fence.admit('wt', 'tab', 'W', 3)).toBe('apply')
  })

  it('orders writers and parent tabs independently and never forgets a living parent', () => {
    const fence = new ChatViewWriteFence()
    fence.admit('wt', 'tab', 'W', 5)
    for (let index = 0; index < 50; index += 1) {
      expect(fence.admit('wt', 'tab', `writer-${index}`, 1)).toBe('apply')
    }
    expect(fence.admit('wt', 'other-tab', 'W', 1)).toBe('apply')
    fence.retainParents('wt', new Set(['tab', 'other-tab']))
    expect(fence.admit('wt', 'tab', 'W', 4)).toBe('superseded')
  })

  it('drops marks with their parent tab or their worktree', () => {
    const fence = new ChatViewWriteFence()
    fence.admit('wt', 'tab', 'W', 5)
    fence.admit('wt', 'tab-2', 'W', 5)
    fence.admit('wt-other', 'tab', 'W', 5)
    fence.retainParents('wt', new Set(['tab-2']))
    expect(fence.admit('wt', 'tab', 'W', 1)).toBe('apply')
    expect(fence.admit('wt', 'tab-2', 'W', 1)).toBe('superseded')
    fence.forgetWorktree('wt')
    expect(fence.admit('wt', 'tab-2', 'W', 1)).toBe('apply')
    expect(fence.admit('wt-other', 'tab', 'W', 1)).toBe('superseded')
  })

  it('lets a resend apply until its write landed, and never confirms a replaced sequence', () => {
    const fence = new ChatViewWriteFence()
    fence.admit('wt', 'tab', 'W', 2)
    expect(fence.admit('wt', 'tab', 'W', 2)).toBe('apply')
    fence.confirm('wt', 'tab', 'W', 2)
    expect(fence.admit('wt', 'tab', 'W', 2)).toBe('duplicate')
    fence.admit('wt', 'tab', 'W', 3)
    fence.confirm('wt', 'tab', 'W', 2)
    expect(fence.admit('wt', 'tab', 'W', 3)).toBe('apply')
  })
})
