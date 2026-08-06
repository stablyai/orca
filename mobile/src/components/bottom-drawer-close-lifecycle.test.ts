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
})
