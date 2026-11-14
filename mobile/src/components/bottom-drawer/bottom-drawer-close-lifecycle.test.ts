import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomDrawer } from './BottomDrawer'
import { findByHostType } from '../../test-support/react-test-renderer-host-nodes'

// BottomDrawer also carries the option pager, which loads these at import.
vi.mock('react-native', () => ({ StyleSheet: { create: <T>(sheet: T) => sheet }, View: 'View' }))
vi.mock('react-native-reanimated', async () =>
  (await import('../../test-support/reanimated-pager-stub')).reanimatedPagerStub()
)
vi.mock('./mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'MountedBottomDrawer'
}))

function drawerElement(visible: boolean, onClose: () => void, onAfterClose: () => void) {
  const props: ComponentProps<typeof BottomDrawer> = {
    visible,
    onClose,
    onAfterClose,
    children: createElement('DrawerContent')
  }
  return createElement(BottomDrawer, props)
}

function renderDrawer(
  visible: boolean,
  onClose: () => void,
  onAfterClose: () => void
): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(drawerElement(visible, onClose, onAfterClose))
  })
  if (!renderer) {
    throw new Error('Bottom drawer did not render')
  }
  return renderer
}

function updateDrawer(
  renderer: ReactTestRenderer,
  visible: boolean,
  onClose: () => void,
  onAfterClose: () => void
): void {
  act(() => {
    renderer.update(drawerElement(visible, onClose, onAfterClose))
  })
}

function mountedDrawer(renderer: ReactTestRenderer) {
  return findByHostType(renderer.root, 'MountedBottomDrawer')
}

describe('BottomDrawer close lifecycle', () => {
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

  it('delivers the latest action once after unmount', () => {
    const firstAfterClose = vi.fn()
    const rendered: { current?: ReactTestRenderer } = {}
    const latestAfterClose = vi.fn(() => {
      expect(rendered.current?.toJSON()).toBeNull()
    })
    const renderer = renderDrawer(true, vi.fn(), firstAfterClose)
    rendered.current = renderer

    updateDrawer(renderer, false, vi.fn(), firstAfterClose)
    updateDrawer(renderer, false, vi.fn(), latestAfterClose)
    const rerenderedOnHidden = mountedDrawer(renderer).props.onHidden

    act(() => {
      rerenderedOnHidden()
      rerenderedOnHidden()
    })
    act(() => {
      rerenderedOnHidden()
    })

    expect(firstAfterClose).not.toHaveBeenCalled()
    expect(latestAfterClose).toHaveBeenCalledTimes(1)
    expect(renderer.toJSON()).toBeNull()
  })
})
