import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useNewWorktreeDrawerNavigation,
  type NewWorktreeDrawerView
} from './use-new-worktree-drawer-navigation'

type Nav = ReturnType<typeof useNewWorktreeDrawerNavigation>
const mounted: ReactTestRenderer[] = []

function renderNavigation(modalVisible: boolean): { current: Nav } {
  const handle: { current: Nav | null } = { current: null }
  function Probe(props: { modalVisible: boolean }) {
    handle.current = useNewWorktreeDrawerNavigation(props.modalVisible)
    return null
  }
  act(() => {
    mounted.push(create(createElement(Probe, { modalVisible })))
  })
  return {
    get current() {
      if (!handle.current) {
        throw new Error('Navigation did not mount')
      }
      return handle.current
    }
  }
}

describe('useNewWorktreeDrawerNavigation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const renderer of mounted.splice(0)) {
      act(() => renderer.unmount())
    }
    vi.useRealTimers()
  })

  // The shared native Modal stays mounted; a transition rendering no sheet leaves a transparent window that swallows taps until the timer fires.
  it('shows the form sheet for the whole transition, even if the queued timer never lands', () => {
    const nav = renderNavigation(true)
    act(() => nav.current.openSourceDrawer())
    expect(nav.current.drawerView).toBe<NewWorktreeDrawerView>('source')

    act(() => nav.current.transitionDrawer('form'))
    expect(nav.current.drawerView).toBe<NewWorktreeDrawerView>('transition')
    expect(nav.current.formSheetVisible).toBe(true)
    expect(nav.current.formSheetInteractive).toBe(false)
  })

  it('keeps a sheet on screen while swapping to a content-sized picker', () => {
    const nav = renderNavigation(true)
    act(() => nav.current.transitionDrawer('agent'))

    expect(nav.current.drawerView).toBe<NewWorktreeDrawerView>('transition')
    expect(nav.current.formSheetVisible).toBe(true)

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(nav.current.drawerView).toBe<NewWorktreeDrawerView>('agent')
    expect(nav.current.formSheetVisible).toBe(false)
  })

  it('hands the form back interactive once the transition lands', () => {
    const nav = renderNavigation(true)
    act(() => nav.current.openSourceDrawer())
    act(() => nav.current.transitionDrawer('form'))
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(nav.current.drawerView).toBe<NewWorktreeDrawerView>('form')
    expect(nav.current.formSheetVisible).toBe(true)
    expect(nav.current.formSheetInteractive).toBe(true)
  })
})
