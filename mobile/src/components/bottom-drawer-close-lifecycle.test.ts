import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomDrawer } from './BottomDrawer'

vi.mock('./mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'MountedBottomDrawer'
}))

function renderDrawer(
  visible: boolean,
  onClose: () => void,
  onAfterClose: () => void
): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(
      createElement(
        BottomDrawer,
        { visible, onClose, onAfterClose },
        createElement('DrawerContent')
      )
    )
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
    renderer.update(
      createElement(
        BottomDrawer,
        { visible, onClose, onAfterClose },
        createElement('DrawerContent')
      )
    )
  })
}

function mountedDrawer(renderer: ReactTestRenderer) {
  return renderer.root.findByType('MountedBottomDrawer')
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

  // The hide finished and the drawer reopened before the scheduled JS callback ran; that late
  // callback used to latch, so the next close never unmounted and its invisible Modal ate taps.
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
