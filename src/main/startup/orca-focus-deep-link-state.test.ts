import { describe, expect, it, vi } from 'vitest'
import { OrcaFocusDeepLinkState } from './orca-focus-deep-link-state'

describe('OrcaFocusDeepLinkState', () => {
  it('queues a startup focus link until it is consumed once', () => {
    const state = new OrcaFocusDeepLinkState()

    expect(state.capture(['orca', 'orca://focus/term_startup'])).toBe(true)
    expect(state.consume()).toBe('term_startup')
    expect(state.consume()).toBeNull()
  })

  it('replays only the most recent link and publishes it', () => {
    const state = new OrcaFocusDeepLinkState()
    const publish = vi.fn()

    state.capture(['orca', 'orca://focus/term_first'])
    expect(state.capture(['orca', 'orca://focus/term_second'], publish)).toBe(true)

    expect(publish).toHaveBeenCalledWith('term_second')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(state.consume()).toBe('term_second')
  })

  it('ignores non-focus URLs without replacing a pending intent', () => {
    const state = new OrcaFocusDeepLinkState()
    const publish = vi.fn()
    state.capture(['orca', 'orca://focus/term_safe'])

    expect(state.capture(['orca', 'orca://skills/share/share_bad'], publish)).toBe(false)
    expect(state.capture(['orca', 'orca://pair/token_bad'], publish)).toBe(false)
    expect(state.capture(['orca', 'orca://focus/not a handle'], publish)).toBe(false)
    expect(state.capture(['orca', '--serve'], publish)).toBe(false)

    expect(publish).not.toHaveBeenCalled()
    expect(state.consume()).toBe('term_safe')
  })

  it('holds a cold-launch link until the window and runtime can honour it', () => {
    const state = new OrcaFocusDeepLinkState()
    const focused: string[] = []
    let ready = false
    const deliver = (): void => {
      if (!ready) {
        return
      }
      const handle = state.consume()
      if (handle) {
        focused.push(handle)
      }
    }

    state.capture(['orca', 'orca://focus/term_cold'], deliver)
    expect(focused).toEqual([])

    ready = true
    deliver()
    expect(focused).toEqual(['term_cold'])

    // A second flush after startup must not re-focus the same terminal.
    deliver()
    expect(focused).toEqual(['term_cold'])
  })
})
