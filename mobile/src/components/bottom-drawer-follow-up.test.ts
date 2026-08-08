import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomDrawer } from './BottomDrawer'
import {
  createBottomDrawerFollowUp,
  useBottomDrawerFollowUp,
  type BottomDrawerFollowUp
} from './bottom-drawer-follow-up'

vi.mock('./mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'MountedBottomDrawer'
}))

describe('createBottomDrawerFollowUp', () => {
  it('closes first and holds the follow-up until the drawer is gone', () => {
    const close = vi.fn()
    const followUp = vi.fn()
    const drawer = createBottomDrawerFollowUp(close)

    drawer.closeThen(followUp)

    expect(close).toHaveBeenCalledTimes(1)
    expect(followUp).not.toHaveBeenCalled()

    drawer.drawerProps.onAfterClose()

    expect(followUp).toHaveBeenCalledTimes(1)
  })

  it('runs a pending follow-up once, not on every later close', () => {
    const drawer = createBottomDrawerFollowUp(vi.fn())
    const followUp = vi.fn()

    drawer.closeThen(followUp)
    drawer.drawerProps.onAfterClose()
    drawer.drawerProps.onAfterClose()

    expect(followUp).toHaveBeenCalledTimes(1)
  })

  it('runs nothing when the drawer is dismissed instead of acted on', () => {
    const close = vi.fn()
    const drawer = createBottomDrawerFollowUp(close)

    drawer.drawerProps.onClose()
    drawer.drawerProps.onAfterClose()

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('keeps the last action when two are taken before the close lands', () => {
    const drawer = createBottomDrawerFollowUp(vi.fn())
    const first = vi.fn()
    const second = vi.fn()

    drawer.closeThen(first)
    drawer.closeThen(second)
    drawer.drawerProps.onAfterClose()

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('useBottomDrawerFollowUp wired to a BottomDrawer', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalConsoleError = console.error
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      const message = args[0]
      if (
        typeof message === 'string' &&
        (message.includes('react-test-renderer is deprecated') ||
          message.includes('The current testing environment is not configured to support act'))
      ) {
        return
      }
      originalConsoleError(...args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Why: the screen-level contract behind the fix — a drawer action that opens
  // another drawer must not fire while this drawer's native window is up.
  it('defers the action until the drawer has unmounted', () => {
    const openSecondDrawer = vi.fn()
    const screen: {
      item: string | null
      drawer?: BottomDrawerFollowUp
      renderer?: ReactTestRenderer
    } = { item: 'task' }

    function Host() {
      const drawer = useBottomDrawerFollowUp<string>((next) => {
        screen.item = typeof next === 'function' ? next(screen.item) : next
      })
      screen.drawer = drawer
      return createElement(
        BottomDrawer,
        { visible: screen.item != null, ...drawer.drawerProps },
        createElement('DrawerContent')
      )
    }

    act(() => {
      screen.renderer = create(createElement(Host))
    })
    const renderer = screen.renderer
    const drawer = screen.drawer
    if (!renderer || !drawer) {
      throw new Error('Drawer host did not render')
    }

    act(() => drawer.closeThen(openSecondDrawer))
    act(() => renderer.update(createElement(Host)))

    expect(screen.item).toBeNull()
    expect(openSecondDrawer).not.toHaveBeenCalled()
    expect(renderer.toJSON()).not.toBeNull()

    act(() => renderer.root.findByType('MountedBottomDrawer').props.onHidden())

    expect(renderer.toJSON()).toBeNull()
    expect(openSecondDrawer).toHaveBeenCalledTimes(1)
  })
})
