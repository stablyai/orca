import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from 'react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { MountedBottomDrawer } from '../components/mounted-bottom-drawer'
import { TasksDrawerModalHost } from './tasks-drawer-host-mount'

vi.mock('../components/mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'MountedBottomDrawer'
}))

vi.mock('react-native', async () => {
  const react = await vi.importActual<typeof import('react')>('react')
  return {
    Modal: ({ children }: { children?: ReactNode }) => react.createElement('Modal', null, children)
  }
})

function Stack({ openCount }: { openCount: number }) {
  return (
    <TasksDrawerModalHost openCount={openCount} onRequestClose={() => {}}>
      <BottomDrawer visible={openCount > 1} onClose={() => {}}>
        {createElement('Top')}
      </BottomDrawer>
      <BottomDrawer visible={openCount > 0} onClose={() => {}}>
        {createElement('Base')}
      </BottomDrawer>
    </TasksDrawerModalHost>
  )
}

function SwappingStack({ first, second }: { first: boolean; second: boolean }) {
  return (
    <TasksDrawerModalHost openCount={Number(first) + Number(second)} onRequestClose={() => {}}>
      <BottomDrawer visible={first} onClose={() => {}}>
        {createElement('First')}
      </BottomDrawer>
      <BottomDrawer visible={second} onClose={() => {}}>
        {createElement('Second')}
      </BottomDrawer>
    </TasksDrawerModalHost>
  )
}

function renderHost(openCount: number): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(Stack, { openCount }))
  })
  if (!renderer) {
    throw new Error('drawer host did not render')
  }
  return renderer
}

function renderSwappingStack(first: boolean, second: boolean): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(SwappingStack, { first, second }))
  })
  if (!renderer) {
    throw new Error('drawer host did not render')
  }
  return renderer
}

function setSwappingStack(renderer: ReactTestRenderer, first: boolean, second: boolean): void {
  act(() => {
    renderer.update(createElement(SwappingStack, { first, second }))
  })
}

function setOpenCount(renderer: ReactTestRenderer, openCount: number): void {
  act(() => {
    renderer.update(createElement(Stack, { openCount }))
  })
}

function mountedDrawers(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(MountedBottomDrawer)
}

function hostModals(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(Modal)
}

describe('TasksDrawerModalHost close', () => {
  beforeEach(() => {
    const originalConsoleError = console.error
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      const message = args[0]
      if (
        typeof message === 'string' &&
        message.includes('The current testing environment is not configured to support act')
      ) {
        return
      }
      originalConsoleError(...args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the host mounted until the last sheet finishes closing', () => {
    const renderer = renderHost(1)

    expect(mountedDrawers(renderer)).toHaveLength(1)
    setOpenCount(renderer, 0)
    expect(mountedDrawers(renderer)).toHaveLength(1)
    expect(mountedDrawers(renderer)[0]?.props.visible).toBe(false)

    act(() => {
      mountedDrawers(renderer)[0]?.props.onHidden()
    })

    expect(mountedDrawers(renderer)).toHaveLength(0)
  })

  it('stays mounted until every sheet closed in that update has finished', () => {
    const renderer = renderHost(2)
    setOpenCount(renderer, 0)
    expect(mountedDrawers(renderer)).toHaveLength(2)

    act(() => {
      mountedDrawers(renderer)[0]?.props.onHidden()
    })
    expect(mountedDrawers(renderer)).toHaveLength(1)

    act(() => {
      mountedDrawers(renderer)[0]?.props.onHidden()
    })
    expect(mountedDrawers(renderer)).toHaveLength(0)
  })

  it('unmounts after a sheet reopens before its hide animation finishes', () => {
    const renderer = renderHost(1)
    setOpenCount(renderer, 0)
    setOpenCount(renderer, 1)
    setOpenCount(renderer, 0)
    expect(mountedDrawers(renderer)).toHaveLength(1)

    act(() => {
      mountedDrawers(renderer)[0]?.props.onHidden()
    })

    expect(hostModals(renderer)).toHaveLength(0)
  })

  it('balances a hide that finishes in the same update as a reopen', () => {
    const renderer = renderHost(1)
    setOpenCount(renderer, 0)
    const closing = mountedDrawers(renderer)[0]

    act(() => {
      closing?.props.onHidden()
      renderer.update(createElement(Stack, { openCount: 1 }))
    })
    setOpenCount(renderer, 0)
    act(() => {
      mountedDrawers(renderer)[0]?.props.onHidden()
    })

    expect(hostModals(renderer)).toHaveLength(0)
  })

  it('keeps the host while a swapped-in sheet is still closing', () => {
    const renderer = renderSwappingStack(true, false)

    setSwappingStack(renderer, false, true)
    expect(mountedDrawers(renderer)).toHaveLength(2)
    expect(mountedDrawers(renderer).map((drawer) => drawer.props.visible)).toEqual([false, true])

    setSwappingStack(renderer, false, false)
    const firstClosing = mountedDrawers(renderer)[0]
    act(() => {
      firstClosing?.props.onHidden()
    })

    expect(hostModals(renderer)).toHaveLength(1)
    expect(mountedDrawers(renderer)).toHaveLength(1)
    expect(mountedDrawers(renderer)[0]?.props.visible).toBe(false)

    act(() => {
      mountedDrawers(renderer)[0]?.props.onHidden()
    })
    expect(hostModals(renderer)).toHaveLength(0)
  })
})
