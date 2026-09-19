import { describe, expect, it, vi } from 'vitest'
import { OrcaFocusDeepLinkState } from './orca-focus-deep-link-state'

describe('OrcaFocusDeepLinkState', () => {
  it('holds a cold-launch focus link until the ready phase consumes it once', () => {
    const state = new OrcaFocusDeepLinkState()

    expect(state.capture(['orca', 'orca://focus?terminal=term_startup'])).toBe(true)
    expect(state.consume()).toEqual({ kind: 'focus', terminal: 'term_startup', worktree: null })
    expect(state.consume()).toBeNull()
  })

  it('publishes a later second-instance intent and lets the newest win', () => {
    const state = new OrcaFocusDeepLinkState()
    const publish = vi.fn()

    state.capture(['orca', 'orca://focus/term_first'])
    expect(state.capture(['orca', 'orca://focus?worktree=branch:feature'], publish)).toBe(true)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(state.consume()).toEqual({ kind: 'focus', terminal: null, worktree: 'branch:feature' })
  })

  it('ignores argv without a focus link and keeps the pending intent', () => {
    const state = new OrcaFocusDeepLinkState()
    const publish = vi.fn()
    state.capture(['orca', 'orca://focus/term_kept'])

    expect(state.capture(['orca', 'orca://skills/share/share_1'], publish)).toBe(false)
    expect(state.capture(['orca', 'orca://pair?code=abc'], publish)).toBe(false)
    expect(state.capture(['orca', '--serve'], publish)).toBe(false)

    expect(publish).not.toHaveBeenCalled()
    expect(state.consume()?.terminal).toBe('term_kept')
  })
})
