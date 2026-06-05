import { beforeEach, describe, expect, it, vi } from 'vitest'

const { screenGetCursorScreenPointMock } = vi.hoisted(() => ({
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 }))
}))

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: screenGetCursorScreenPointMock },
  webContents: { fromId: vi.fn() }
}))

import { setupGuestContextMenu, setupGuestShortcutForwarding } from './browser-guest-ui'

describe('setupGuestContextMenu', () => {
  const browserTabId = 'tab-1'
  let rendererSendMock: ReturnType<typeof vi.fn>
  let guestOnMock: ReturnType<typeof vi.fn>
  let guestOffMock: ReturnType<typeof vi.fn>

  function makeGuest(overrides: Record<string, unknown> = {}) {
    return {
      getURL: vi.fn(() => 'https://example.com'),
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => false),
      navigationHistory: {
        canGoBack: vi.fn(() => true),
        canGoForward: vi.fn(() => false)
      },
      on: guestOnMock,
      off: guestOffMock,
      ...overrides
    } as unknown as Electron.WebContents
  }

  function makeRenderer() {
    return { send: rendererSendMock } as unknown as Electron.WebContents
  }

  beforeEach(() => {
    rendererSendMock = vi.fn()
    guestOnMock = vi.fn()
    guestOffMock = vi.fn()
    screenGetCursorScreenPointMock.mockReturnValue({ x: 0, y: 0 })
  })

  function triggerContextMenu(
    _guest: Electron.WebContents,
    params: Partial<Electron.ContextMenuParams>
  ) {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'context-menu')?.[1] as
      | ((event: unknown, params: Electron.ContextMenuParams) => void)
      | undefined

    expect(handler).toBeTypeOf('function')
    handler!({}, { x: 0, y: 0, linkURL: '', ...params } as Electron.ContextMenuParams)
  }

  it('passes through guest viewport coordinates (params.x/y) to the renderer', () => {
    const guest = makeGuest()
    const renderer = makeRenderer()

    setupGuestContextMenu({
      browserTabId,
      guest,
      resolveRenderer: () => renderer
    })

    triggerContextMenu(guest, { x: 150, y: 275 })

    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:context-menu-requested',
      expect.objectContaining({ x: 150, y: 275 })
    )
  })

  it('includes navigation state and page URL alongside coordinates', () => {
    screenGetCursorScreenPointMock.mockReturnValue({ x: 500, y: 375 })
    const guest = makeGuest({
      getURL: vi.fn(() => 'https://test.dev/page'),
      navigationHistory: {
        canGoBack: vi.fn(() => true),
        canGoForward: vi.fn(() => true)
      }
    })
    const renderer = makeRenderer()

    setupGuestContextMenu({
      browserTabId,
      guest,
      resolveRenderer: () => renderer
    })

    triggerContextMenu(guest, { x: 50, y: 75, linkURL: 'https://test.dev/link' })

    expect(rendererSendMock).toHaveBeenCalledWith('browser:context-menu-requested', {
      browserPageId: browserTabId,
      x: 50,
      y: 75,
      screenX: 500,
      screenY: 375,
      pageUrl: 'https://test.dev/page',
      linkUrl: 'https://test.dev/link',
      canGoBack: true,
      canGoForward: true
    })
  })

  it('reads navigation state from navigationHistory', () => {
    const deprecatedCanGoBack = vi.fn(() => false)
    const deprecatedCanGoForward = vi.fn(() => false)
    const guest = makeGuest({
      canGoBack: deprecatedCanGoBack,
      canGoForward: deprecatedCanGoForward,
      navigationHistory: {
        canGoBack: vi.fn(() => true),
        canGoForward: vi.fn(() => true)
      }
    })
    const renderer = makeRenderer()

    setupGuestContextMenu({
      browserTabId,
      guest,
      resolveRenderer: () => renderer
    })

    triggerContextMenu(guest, { x: 50, y: 75 })

    expect(deprecatedCanGoBack).not.toHaveBeenCalled()
    expect(deprecatedCanGoForward).not.toHaveBeenCalled()
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:context-menu-requested',
      expect.objectContaining({ canGoBack: true, canGoForward: true })
    )
  })

  it('does not send when renderer is unavailable', () => {
    const guest = makeGuest()

    setupGuestContextMenu({
      browserTabId,
      guest,
      resolveRenderer: () => null
    })

    triggerContextMenu(guest, { x: 100, y: 200 })

    expect(rendererSendMock).not.toHaveBeenCalled()
  })

  it('cleans up context-menu listener on teardown', () => {
    const guest = makeGuest()

    const cleanup = setupGuestContextMenu({
      browserTabId,
      guest,
      resolveRenderer: () => makeRenderer()
    })

    cleanup()

    expect(guestOffMock).toHaveBeenCalledWith('context-menu', expect.any(Function))
  })

  describe('dismiss handler', () => {
    function triggerMouseEvent(button: string, type: string = 'mouseDown') {
      const beforeMouseHandler = guestOnMock.mock.calls.find(
        (call) => call[0] === 'before-mouse-event'
      )?.[1] as ((event: unknown, mouse: { type: string; button: string }) => void) | undefined

      expect(beforeMouseHandler).toBeTypeOf('function')
      beforeMouseHandler!({}, { type, button })
    }

    it('dismisses context menu on left-click', () => {
      const guest = makeGuest()
      const renderer = makeRenderer()

      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: () => renderer
      })

      triggerContextMenu(guest, { x: 100, y: 200 })
      rendererSendMock.mockClear()

      triggerMouseEvent('left')

      expect(rendererSendMock).toHaveBeenCalledWith('browser:context-menu-dismissed', {
        browserPageId: browserTabId
      })
    })

    it('does not dismiss context menu on right-click', () => {
      const guest = makeGuest()
      const renderer = makeRenderer()

      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: () => renderer
      })

      triggerContextMenu(guest, { x: 100, y: 200 })
      rendererSendMock.mockClear()

      triggerMouseEvent('right')

      expect(rendererSendMock).not.toHaveBeenCalledWith(
        'browser:context-menu-dismissed',
        expect.anything()
      )
    })

    it('dismisses context menu on middle-click', () => {
      const guest = makeGuest()
      const renderer = makeRenderer()

      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: () => renderer
      })

      triggerContextMenu(guest, { x: 100, y: 200 })
      rendererSendMock.mockClear()

      triggerMouseEvent('middle')

      expect(rendererSendMock).toHaveBeenCalledWith('browser:context-menu-dismissed', {
        browserPageId: browserTabId
      })
    })

    it('ignores non-mouseDown events', () => {
      const guest = makeGuest()
      const renderer = makeRenderer()

      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: () => renderer
      })

      triggerContextMenu(guest, { x: 100, y: 200 })
      rendererSendMock.mockClear()

      triggerMouseEvent('left', 'mouseMove')

      expect(rendererSendMock).not.toHaveBeenCalled()
    })
  })
})

describe('setupGuestShortcutForwarding', () => {
  const browserTabId = 'tab-1'
  let rendererSendMock: ReturnType<typeof vi.fn>
  let guestOnMock: ReturnType<typeof vi.fn>
  let guestOffMock: ReturnType<typeof vi.fn>

  function makeGuest() {
    return {
      on: guestOnMock,
      off: guestOffMock
    } as unknown as Electron.WebContents
  }

  function makeRenderer() {
    return { send: rendererSendMock } as unknown as Electron.WebContents
  }

  function triggerBeforeInput(input: Partial<Electron.Input>): ReturnType<typeof vi.fn> {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'before-input-event')?.[1] as
      | ((event: Electron.Event, input: Electron.Input) => void)
      | undefined
    expect(handler).toBeTypeOf('function')
    const preventDefault = vi.fn()
    handler!(
      { preventDefault } as unknown as Electron.Event,
      {
        type: 'keyDown',
        alt: false,
        meta: process.platform === 'darwin',
        control: process.platform !== 'darwin',
        shift: false,
        ...input
      } as Electron.Input
    )
    return preventDefault
  }

  beforeEach(() => {
    rendererSendMock = vi.fn()
    guestOnMock = vi.fn()
    guestOffMock = vi.fn()
  })

  it('forwards browser page zoom shortcuts from focused guest pages', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer()
    })

    const zoomInPreventDefault = triggerBeforeInput({ code: 'Equal', key: '=' })
    const shiftedPlusPreventDefault = triggerBeforeInput({
      code: 'Equal',
      key: '+',
      shift: true
    })
    const zoomOutPreventDefault = triggerBeforeInput({ code: 'Minus', key: '-' })
    const numpadSubtractPreventDefault = triggerBeforeInput({ code: 'NumpadSubtract', key: '-' })
    const resetPreventDefault = triggerBeforeInput({ code: 'Digit0', key: '0' })
    const repeatPreventDefault = triggerBeforeInput({
      code: 'NumpadAdd',
      key: '+',
      isAutoRepeat: true
    })

    expect(zoomInPreventDefault).toHaveBeenCalledTimes(1)
    expect(shiftedPlusPreventDefault).toHaveBeenCalledTimes(1)
    expect(zoomOutPreventDefault).toHaveBeenCalledTimes(1)
    expect(numpadSubtractPreventDefault).toHaveBeenCalledTimes(1)
    expect(resetPreventDefault).toHaveBeenCalledTimes(1)
    expect(repeatPreventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:zoomBrowserPage', 'in')
    expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:zoomBrowserPage', 'in')
    expect(rendererSendMock).toHaveBeenNthCalledWith(3, 'ui:zoomBrowserPage', 'out')
    expect(rendererSendMock).toHaveBeenNthCalledWith(4, 'ui:zoomBrowserPage', 'out')
    expect(rendererSendMock).toHaveBeenNthCalledWith(5, 'ui:zoomBrowserPage', 'reset')
    expect(rendererSendMock).toHaveBeenNthCalledWith(6, 'ui:zoomBrowserPage', 'in')
  })

  it('consumes guest zoom shortcuts even when the renderer is unavailable', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => null
    })

    const preventDefault = triggerBeforeInput({ code: 'Equal', key: '=' })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).not.toHaveBeenCalled()
  })

  it('uses customized zoom keybindings when forwarding guest shortcuts', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      getKeybindings: () => ({
        'zoom.in': ['Mod+Alt+Z']
      })
    })

    const defaultPreventDefault = triggerBeforeInput({ code: 'Equal', key: '=' })
    const customPreventDefault = triggerBeforeInput({ code: 'KeyZ', key: 'z', alt: true })

    expect(defaultPreventDefault).not.toHaveBeenCalled()
    expect(customPreventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('ui:zoomBrowserPage', 'in')
  })
})
