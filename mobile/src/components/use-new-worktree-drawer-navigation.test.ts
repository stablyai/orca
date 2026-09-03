import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useNewWorktreeDrawerNavigation,
  type NewWorktreeDrawerView
} from './use-new-worktree-drawer-navigation'

type Nav = ReturnType<typeof useNewWorktreeDrawerNavigation>

function renderNavigation(modalVisible: boolean): { current: Nav } {
  const handle = { current: null as unknown as Nav }
  function Probe(props: { modalVisible: boolean }) {
    handle.current = useNewWorktreeDrawerNavigation(props.modalVisible)
    return null
  }
  act(() => {
    create(createElement(Probe, { modalVisible }))
  })
  return handle
}

describe('useNewWorktreeDrawerNavigation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // BottomDrawerModalHost keeps one native Modal mounted for the whole flow. A
  // transition beat that renders no sheet is therefore a transparent full-screen
  // window that eats every tap, and the queued timer is the only way out of it.
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

    act(() => vi.advanceTimersByTime(500))
    expect(nav.current.drawerView).toBe<NewWorktreeDrawerView>('agent')
    expect(nav.current.formSheetVisible).toBe(false)
  })

  it('hands the form back interactive once the transition lands', () => {
    const nav = renderNavigation(true)
    act(() => nav.current.openSourceDrawer())
    act(() => nav.current.transitionDrawer('form'))
    act(() => vi.advanceTimersByTime(500))

    expect(nav.current.drawerView).toBe<NewWorktreeDrawerView>('form')
    expect(nav.current.formSheetVisible).toBe(true)
    expect(nav.current.formSheetInteractive).toBe(true)
  })
})
