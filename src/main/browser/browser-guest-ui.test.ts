/* eslint-disable max-lines -- Why: these tests cover the paired browser guest
context-menu and shortcut-forwarding hooks that share the same fake guest. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { screenGetCursorScreenPointMock } = vi.hoisted(() => ({
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 }))
}))

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: screenGetCursorScreenPointMock },
  webContents: { fromId: vi.fn() }
}))

import { keybindingCatalog } from '../../shared/keybindings/keybinding-catalog'
import { buildEffectiveKeymap } from '../../shared/keybindings/effective-keymap'
import {
  setupGrabShortcutForwarding,
  setupGuestContextMenu,
  setupGuestShortcutForwarding
} from './browser-guest-ui'
import type { EffectiveKeymap } from '../../shared/keybindings/keybinding-types'

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
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => true)
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

  function triggerKeydown(input: Partial<Electron.Input>) {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'before-input-event')?.[1] as
      | ((event: { preventDefault: () => void }, input: Electron.Input) => void)
      | undefined

    expect(handler).toBeTypeOf('function')
    const preventDefault = vi.fn()
    handler!({ preventDefault }, {
      type: 'keyDown',
      key: '',
      code: '',
      meta: false,
      control: false,
      alt: false,
      shift: false,
      ...input
    } as Electron.Input)
    return preventDefault
  }

  function keymap(overrides: Record<string, string | string[] | 'none'>): EffectiveKeymap {
    return buildEffectiveKeymap({
      catalog: keybindingCatalog,
      platform: 'linux',
      overrides
    })
  }

  beforeEach(() => {
    rendererSendMock = vi.fn()
    guestOnMock = vi.fn()
    guestOffMock = vi.fn()
  })

  it('uses the effective keymap for browser guest reload shortcuts', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      getEffectiveKeymap: () => keymap({ 'browser.page.reload': 'ctrl+shift+y' })
    })

    expect(triggerKeydown({ key: 'r', code: 'KeyR', control: true }).mock.calls.length).toBe(0)

    const preventDefault = triggerKeydown({
      key: 'Y',
      code: 'KeyY',
      control: true,
      shift: true
    })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('ui:reloadBrowserPage')
  })

  it('honors explicit unbinding for browser guest actions', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      getEffectiveKeymap: () => keymap({ 'browser.tab.new': 'none' })
    })

    const preventDefault = triggerKeydown({
      key: 'B',
      code: 'KeyB',
      control: true,
      shift: true
    })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(rendererSendMock).not.toHaveBeenCalled()
  })

  it('matches shifted bracket shortcuts by physical code when Electron reports a shifted key', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      getEffectiveKeymap: () => keymap({})
    })

    const preventDefault = triggerKeydown({
      key: '}',
      code: 'BracketRight',
      control: true,
      shift: true
    })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('ui:switchTab', 1)
  })
})

describe('setupGrabShortcutForwarding', () => {
  const browserTabId = 'tab-1'
  let rendererSendMock: ReturnType<typeof vi.fn>
  let guestOnMock: ReturnType<typeof vi.fn>
  let guestOffMock: ReturnType<typeof vi.fn>
  let executeJavaScriptMock: ReturnType<typeof vi.fn>

  function makeGuest() {
    return {
      on: guestOnMock,
      off: guestOffMock,
      executeJavaScript: executeJavaScriptMock
    } as unknown as Electron.WebContents
  }

  function makeRenderer() {
    return { send: rendererSendMock } as unknown as Electron.WebContents
  }

  function keymap(overrides: Record<string, string | string[] | 'none'>): EffectiveKeymap {
    return buildEffectiveKeymap({
      catalog: keybindingCatalog,
      platform: 'linux',
      overrides
    })
  }

  function triggerKeydown(input: Partial<Electron.Input>) {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'before-input-event')?.[1] as
      | ((event: { preventDefault: () => void }, input: Electron.Input) => void)
      | undefined

    expect(handler).toBeTypeOf('function')
    const preventDefault = vi.fn()
    handler!({ preventDefault }, {
      type: 'keyDown',
      key: '',
      code: '',
      meta: false,
      control: false,
      alt: false,
      shift: false,
      ...input
    } as Electron.Input)
    return preventDefault
  }

  beforeEach(() => {
    rendererSendMock = vi.fn()
    guestOnMock = vi.fn()
    guestOffMock = vi.fn()
    executeJavaScriptMock = vi.fn().mockResolvedValue(true)
  })

  it('uses the effective keymap for the browser grab-mode toggle', async () => {
    setupGrabShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      hasActiveGrabOp: () => false,
      getEffectiveKeymap: () => keymap({ 'browser.grabMode.toggle': 'ctrl+g' })
    })

    expect(triggerKeydown({ key: 'c', code: 'KeyC', control: true })).not.toHaveBeenCalled()

    const preventDefault = triggerKeydown({ key: 'g', code: 'KeyG', control: true })
    await Promise.resolve()

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('browser:grabModeToggle', browserTabId)
  })
})
