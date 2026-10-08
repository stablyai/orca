import { describe, expect, it, vi } from 'vitest'
import { computeTerminalTailWaitState } from './terminal-wait-tail-state'

describe('terminal tail wait state', () => {
  it('computeTerminalTailWaitState reports fromTail and blocked signals', () => {
    const empty = computeTerminalTailWaitState([], '', '')
    expect(empty.fromTail).toBe(false)
    expect(empty.signal).toBeNull()

    const previewOnly = computeTerminalTailWaitState([], '', 'short preview')
    expect(previewOnly.fromTail).toBe(false)
    expect(previewOnly.waitText).toBe('short preview')

    const blocked = computeTerminalTailWaitState(
      ['Update available! Press Enter to continue.'],
      '',
      ''
    )
    expect(blocked.fromTail).toBe(true)
    expect(blocked.signal?.reason).toBe('agent-update-prompt')
  })

  it('does not rebuild or repeatedly scan an ordinary saturated tail', () => {
    const lines = Array.from({ length: 2000 }, () => 'x'.repeat(126))
    const lastIndexOf = vi.spyOn(String.prototype, 'lastIndexOf')

    try {
      const state = computeTerminalTailWaitState(lines, '', '')

      expect(state.signal).toBeNull()
      expect(state.waitText).toBe('')
      expect(lastIndexOf).not.toHaveBeenCalled()
    } finally {
      lastIndexOf.mockRestore()
    }
  })
})
