import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSelectedSidebarSession } from '../host-screen/selected-sidebar-session'
import { useWorktreeRowSession, useWorktreeSessionPress } from './worktree-session-press'

function Probe({
  onPress,
  hold
}: {
  onPress: () => void
  hold: { current?: ReturnType<typeof useWorktreeSessionPress> }
}): null {
  hold.current = useWorktreeSessionPress(onPress)
  return null
}

describe('useWorktreeSessionPress', () => {
  it('lets the session row take the touch instead of the workspace behind it', () => {
    const onPress = vi.fn()
    const hold: { current?: ReturnType<typeof useWorktreeSessionPress> } = {}
    act(() => {
      create(createElement(Probe, { onPress, hold }))
    })
    const press = hold.current
    if (!press) {
      throw new Error('the press handlers were not installed')
    }
    press.claim()
    expect(press.isClaimed()).toBe(true)
    press.press()
    expect(onPress).not.toHaveBeenCalled()
    expect(press.isClaimed()).toBe(false)
    press.press()
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})

describe('useWorktreeRowSession', () => {
  afterEach(() => {
    setSelectedSidebarSession(null)
  })

  it('highlights only the session a tap opens, and a workspace tap clears it', () => {
    const onPress = vi.fn()
    const onAgentPress = vi.fn()
    const item = { worktreeId: 'wt-1', isActive: true }
    const hold: { current?: ReturnType<typeof useWorktreeRowSession> } = {}
    function Probe(): null {
      hold.current = useWorktreeRowSession(item, true, onPress, onAgentPress)
      return null
    }
    act(() => {
      create(createElement(Probe))
    })
    const session = hold.current
    if (!session) {
      throw new Error('the session handlers were not installed')
    }
    expect(session.highlightedPane).toBeNull()
    act(() => session.openAgent?.('pane-a'))
    expect(onAgentPress).toHaveBeenCalledWith(item, 'pane-a')
    expect(hold.current?.highlightedPane).toBe('pane-a')
    act(() => hold.current?.claim())
    act(() => hold.current?.press())
    expect(onPress).not.toHaveBeenCalled()
    expect(hold.current?.highlightedPane).toBe('pane-a')
    act(() => hold.current?.press())
    expect(onPress).toHaveBeenCalledWith(item)
    expect(hold.current?.highlightedPane).toBeNull()
  })

  it('opens the workspace after the session row claimed the touch', () => {
    const onPress = vi.fn()
    const onAgentPress = vi.fn()
    const item = { worktreeId: 'wt-1', isActive: true }
    const hold: { current?: ReturnType<typeof useWorktreeRowSession> } = {}
    function Probe(): null {
      hold.current = useWorktreeRowSession(item, true, onPress, onAgentPress)
      return null
    }
    act(() => {
      create(createElement(Probe))
    })
    act(() => hold.current?.openAgent?.('pane-a'))
    act(() => hold.current?.claim())
    act(() => hold.current?.openWorkspace())
    expect(onPress).toHaveBeenCalledWith(item)
    expect(onAgentPress).toHaveBeenCalledTimes(1)
    expect(hold.current?.highlightedPane).toBeNull()
  })
})
