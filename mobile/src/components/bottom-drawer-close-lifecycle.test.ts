import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomDrawer } from './BottomDrawer'
import { findByHostType } from '../test-support/react-test-renderer-host-nodes'

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

  it('keeps close stable and delivers the latest action once after unmount', () => {
    const firstAfterClose = vi.fn()
    const rendered: { current?: ReactTestRenderer } = {}
    const latestAfterClose = vi.fn(() => {
      expect(rendered.current?.toJSON()).toBeNull()
    })
    const renderer = renderDrawer(true, vi.fn(), firstAfterClose)
    rendered.current = renderer
    const initialOnHidden = mountedDrawer(renderer).props.onHidden

    updateDrawer(renderer, false, vi.fn(), firstAfterClose)
    const closingOnHidden = mountedDrawer(renderer).props.onHidden
    updateDrawer(renderer, false, vi.fn(), latestAfterClose)
    const rerenderedOnHidden = mountedDrawer(renderer).props.onHidden

    expect(closingOnHidden).toBe(initialOnHidden)
    expect(rerenderedOnHidden).toBe(initialOnHidden)

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

  // Reopen before queued hide callback must invalidate it or next close leaves invisible tap-swallowing Modal.
  it('a hide that lands after a reopen does not swallow the next close', () => {
    const onAfterClose = vi.fn()
    const renderer = renderDrawer(true, vi.fn(), onAfterClose)
    const lateOnHidden = mountedDrawer(renderer).props.onHidden
    updateDrawer(renderer, false, vi.fn(), onAfterClose)
    updateDrawer(renderer, true, vi.fn(), onAfterClose)

    act(() => lateOnHidden())
    expect(mountedDrawer(renderer).props.visible).toBe(true)
    expect(onAfterClose).not.toHaveBeenCalled()

    updateDrawer(renderer, false, vi.fn(), onAfterClose)
    act(() => mountedDrawer(renderer).props.onHidden())
    expect(renderer.toJSON()).toBeNull()
    expect(onAfterClose).toHaveBeenCalledTimes(1)
  })
})
