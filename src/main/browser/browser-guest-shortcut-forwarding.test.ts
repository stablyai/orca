import { beforeEach, describe, expect, it, vi } from 'vitest'

const { screenGetCursorScreenPointMock } = vi.hoisted(() => ({
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 }))
}))

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: screenGetCursorScreenPointMock },
  webContents: { fromId: vi.fn() }
}))

import { setupGuestMouseWheelZoomForwarding } from './browser-guest-wheel-zoom'
import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'

const zoomTo = (direction: 'in' | 'out' | 'reset') => ({ browserPageId: 'tab-1', direction })

describe('guest mouse wheel browser zoom', () => {
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

  function mouseWheel(
    overrides: Partial<Electron.MouseWheelInputEvent> = {}
  ): Electron.MouseWheelInputEvent {
    return {
      type: 'mouseWheel',
      x: 0,
      y: 0,
      deltaY: -120,
      modifiers: ['ctrl'],
      ...overrides
    }
  }

  function triggerBeforeMouse(mouse: Electron.MouseInputEvent): ReturnType<typeof vi.fn> {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'before-mouse-event')?.[1] as
      | ((event: Electron.Event, mouse: Electron.MouseInputEvent) => void)
      | undefined
    expect(handler).toBeTypeOf('function')
    const preventDefault = vi.fn()
    handler!({ preventDefault } as unknown as Electron.Event, mouse)
    return preventDefault
  }

  beforeEach(() => {
    rendererSendMock = vi.fn()
    guestOnMock = vi.fn()
    guestOffMock = vi.fn()
  })

  it('forwards ctrl wheel to browser page zoom and consumes the guest wheel event', () => {
    setupGuestMouseWheelZoomForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer()
    })

    const preventDefault = triggerBeforeMouse(mouseWheel({ deltaY: -120 }))
    const outPreventDefault = triggerBeforeMouse(mouseWheel({ deltaY: 120 }))

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(outPreventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:zoomBrowserPage', zoomTo('in'))
    expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:zoomBrowserPage', zoomTo('out'))
  })

  it('consumes guest ctrl wheel even when the renderer is unavailable', () => {
    setupGuestMouseWheelZoomForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => null
    })

    const preventDefault = triggerBeforeMouse(mouseWheel())

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).not.toHaveBeenCalled()
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

  function triggerZoomChanged(direction: 'in' | 'out' | 'reset'): ReturnType<typeof vi.fn> {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'zoom-changed')?.[1] as
      | ((event: Electron.Event, direction: 'in' | 'out' | 'reset') => void)
      | undefined
    expect(handler).toBeTypeOf('function')
    const preventDefault = vi.fn()
    handler!({ preventDefault } as unknown as Electron.Event, direction)
    return preventDefault
  }

  function triggerBeforeMouse(mouse: Electron.MouseInputEvent): ReturnType<typeof vi.fn> {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'before-mouse-event')?.[1] as
      | ((event: Electron.Event, mouse: Electron.MouseInputEvent) => void)
      | undefined
    expect(handler).toBeTypeOf('function')
    const preventDefault = vi.fn()
    handler!({ preventDefault } as unknown as Electron.Event, mouse)
    return preventDefault
  }

  function triggerGuestBlur(): void {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'blur')?.[1] as
      | (() => void)
      | undefined
    expect(handler).toBeTypeOf('function')
    handler!()
  }

  beforeEach(() => {
    rendererSendMock = vi.fn()
    guestOnMock = vi.fn()
    guestOffMock = vi.fn()
  })

  it('replays the Plugins shortcut once and preserves unbound overrides', () => {
    let keybindings = { 'view.plugins': ['Mod+Shift+X'] }
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      getKeybindings: () => keybindings
    })

    const input = { key: 'X', code: 'KeyX', shift: true }
    expect(triggerBeforeInput(input)).toHaveBeenCalledOnce()
    expect(rendererSendMock).toHaveBeenCalledWith(
      'ui:browserPageTabShortcut',
      expect.objectContaining(input)
    )
    expect(triggerBeforeInput({ ...input, isAutoRepeat: true })).toHaveBeenCalledOnce()
    expect(rendererSendMock).toHaveBeenCalledTimes(1)

    keybindings = { 'view.plugins': [] }
    expect(triggerBeforeInput(input)).not.toHaveBeenCalled()
    expect(rendererSendMock).toHaveBeenCalledTimes(1)
  })

  it('commits Ctrl+Tab switching from focused guest pages on generic release events', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer()
    })

    const ctrlTabInput = { code: 'Tab', key: 'Tab', control: true, meta: false }
    const releaseInputs: Partial<Electron.Input>[] = [
      {
        type: 'keyUp',
        code: 'Control',
        key: 'Control',
        control: false,
        meta: false
      },
      {
        type: 'keyUp',
        code: 'Tab',
        key: 'Tab',
        control: false,
        meta: false
      }
    ]

    for (const releaseInput of releaseInputs) {
      rendererSendMock.mockClear()
      const keyDownPreventDefault = triggerBeforeInput(ctrlTabInput)
      const tabReleasePreventDefault = triggerBeforeInput({ ...ctrlTabInput, type: 'keyUp' })
      const keyUpPreventDefault = triggerBeforeInput(releaseInput)

      // Preventing keydown loses the commit keyup in Electron.
      expect(keyDownPreventDefault).not.toHaveBeenCalled()
      expect(tabReleasePreventDefault).not.toHaveBeenCalled()
      expect(keyUpPreventDefault).toHaveBeenCalledTimes(1)
      expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:ctrlTabKeyDown', {
        shiftKey: false
      })
      expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:ctrlTabKeyUp')
    }
  })

  // Why: Orca claims these on every repeat but acts once, so a held chord's repeats never reach the page.
  it.each([
    ['workspace delete', { code: 'Backspace', key: 'Backspace' }],
    ['next tab', { code: 'BracketRight', key: '}' }]
  ])('consumes repeated %s shortcuts from focused guest pages', (_name, chord) => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer()
    })

    const isMac = process.platform === 'darwin'
    const preventDefault = triggerBeforeInput({
      ...chord,
      meta: isMac,
      control: !isMac,
      shift: true,
      isAutoRepeat: true
    })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(rendererSendMock).not.toHaveBeenCalled()
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
    expect(rendererSendMock).toHaveBeenCalledWith('ui:zoomBrowserPage', zoomTo('in'))
  })

  it('forwards native guest zoom commands to browser page zoom when default zoom keys are bound', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer()
    })

    const zoomOutPreventDefault = triggerZoomChanged('out')
    const zoomInPreventDefault = triggerZoomChanged('in')
    const resetPreventDefault = triggerZoomChanged('reset')

    expect(zoomOutPreventDefault).toHaveBeenCalledTimes(1)
    expect(zoomInPreventDefault).toHaveBeenCalledTimes(1)
    expect(resetPreventDefault).not.toHaveBeenCalled()
    expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:zoomBrowserPage', zoomTo('out'))
    expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:zoomBrowserPage', zoomTo('in'))
  })

  it('does not double-forward ctrl wheel when Electron also emits a native zoom command', () => {
    const guest = makeGuest()

    setupGuestMouseWheelZoomForwarding({
      browserTabId,
      guest,
      resolveRenderer: () => makeRenderer()
    })
    setupGuestShortcutForwarding({
      browserTabId,
      guest,
      resolveRenderer: () => makeRenderer()
    })

    const wheelPreventDefault = triggerBeforeMouse({
      type: 'mouseWheel',
      x: 0,
      y: 0,
      deltaY: -120,
      modifiers: ['ctrl']
    } as Electron.MouseWheelInputEvent)
    const zoomCommandPreventDefault = triggerZoomChanged('in')

    expect(wheelPreventDefault).toHaveBeenCalledTimes(1)
    expect(zoomCommandPreventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('ui:zoomBrowserPage', zoomTo('in'))
  })

  it('ignores native guest zoom commands when matching default zoom keys are unbound', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      getKeybindings: () => ({
        'zoom.in': ['Mod+Alt+Z'],
        'zoom.out': []
      })
    })

    const zoomOutPreventDefault = triggerZoomChanged('out')
    const zoomInPreventDefault = triggerZoomChanged('in')

    expect(zoomOutPreventDefault).not.toHaveBeenCalled()
    expect(zoomInPreventDefault).not.toHaveBeenCalled()
    expect(rendererSendMock).not.toHaveBeenCalled()
  })

  it('forwards double-tap window shortcuts from focused guest pages', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      getKeybindings: () => ({
        'worktree.quickOpen': ['DoubleTap+Shift']
      })
    })

    const modifierInput = {
      code: 'ShiftLeft',
      key: 'Shift',
      shift: true,
      meta: false,
      control: false,
      alt: false
    }
    const firstDownPreventDefault = triggerBeforeInput(modifierInput)
    const firstUpPreventDefault = triggerBeforeInput({ ...modifierInput, type: 'keyUp' })
    const secondDownPreventDefault = triggerBeforeInput(modifierInput)

    expect(firstDownPreventDefault).not.toHaveBeenCalled()
    expect(firstUpPreventDefault).not.toHaveBeenCalled()
    expect(secondDownPreventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('ui:openQuickOpen')
  })

  it('forwards double-tap tab shortcuts from focused guest pages', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      getKeybindings: () => ({
        'tab.newBrowser': ['DoubleTap+Shift']
      })
    })

    const modifierInput = {
      code: 'ShiftLeft',
      key: 'Shift',
      shift: true,
      meta: false,
      control: false,
      alt: false
    }
    triggerBeforeInput(modifierInput)
    triggerBeforeInput({ ...modifierInput, type: 'keyUp' })
    const secondDownPreventDefault = triggerBeforeInput(modifierInput)

    expect(secondDownPreventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('ui:browserPageTabShortcut', {
      doubleTapModifier: 'Shift'
    })
  })

  it('resets guest double-tap detection on blur', () => {
    setupGuestShortcutForwarding({
      browserTabId,
      guest: makeGuest(),
      resolveRenderer: () => makeRenderer(),
      getKeybindings: () => ({
        'worktree.quickOpen': ['DoubleTap+Shift']
      })
    })

    const modifierInput = {
      code: 'ShiftLeft',
      key: 'Shift',
      shift: true,
      meta: false,
      control: false,
      alt: false
    }
    triggerBeforeInput(modifierInput)
    triggerBeforeInput({ ...modifierInput, type: 'keyUp' })
    triggerGuestBlur()
    const nextDownPreventDefault = triggerBeforeInput(modifierInput)

    expect(nextDownPreventDefault).not.toHaveBeenCalled()
    expect(rendererSendMock).not.toHaveBeenCalledWith('ui:openQuickOpen')
  })

  describe('source-aware close/index routing', () => {
    const closeInput = { code: 'KeyW', key: 'w' }
    const workspaceIndexInput = { code: 'Digit1', key: '1' }
    const tabIndexInput =
      process.platform === 'darwin'
        ? { code: 'Digit1', key: '1', control: true, meta: false }
        : { code: 'Digit1', key: '1', alt: true, control: false }

    it('routes tab.close to ui:closeFloatingItem with the source id for a floating guest', () => {
      setupGuestShortcutForwarding({
        browserTabId,
        guest: makeGuest(),
        resolveRenderer: () => makeRenderer(),
        resolveWorktreeId: () => 'global-floating-terminal'
      })

      const preventDefault = triggerBeforeInput(closeInput)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(rendererSendMock).toHaveBeenCalledWith('ui:closeFloatingItem', {
        sourceId: browserTabId
      })
      expect(rendererSendMock.mock.calls.some(([channel]) => channel === 'ui:closeActiveTab')).toBe(
        false
      )
    })

    it('routes workspace/tab index chords to ui:selectFloatingIndex for a floating guest', () => {
      setupGuestShortcutForwarding({
        browserTabId,
        guest: makeGuest(),
        resolveRenderer: () => makeRenderer(),
        resolveWorktreeId: () => 'global-floating-terminal'
      })

      triggerBeforeInput(workspaceIndexInput)
      triggerBeforeInput(tabIndexInput)

      expect(rendererSendMock).toHaveBeenCalledWith('ui:selectFloatingIndex', { index: 0 })
      expect(rendererSendMock).toHaveBeenCalledTimes(2)
      expect(rendererSendMock).not.toHaveBeenCalledWith('ui:jumpToWorktreeIndex', 0)
      expect(rendererSendMock).not.toHaveBeenCalledWith('ui:jumpToTabIndex', 0)
    })

    it('keeps main routing for a non-floating guest', () => {
      setupGuestShortcutForwarding({
        browserTabId,
        guest: makeGuest(),
        resolveRenderer: () => makeRenderer(),
        resolveWorktreeId: () => 'some-worktree'
      })

      triggerBeforeInput(closeInput)
      triggerBeforeInput(workspaceIndexInput)

      expect(rendererSendMock).toHaveBeenCalledWith('ui:closeActiveTab', { sourceId: browserTabId })
      expect(rendererSendMock).toHaveBeenCalledWith('ui:jumpToWorktreeIndex', 0)
      expect(rendererSendMock).not.toHaveBeenCalledWith('ui:closeFloatingItem', expect.anything())
      expect(rendererSendMock).not.toHaveBeenCalledWith('ui:selectFloatingIndex', expect.anything())
    })

    it('keeps main routing when no worktree resolver is provided', () => {
      setupGuestShortcutForwarding({
        browserTabId,
        guest: makeGuest(),
        resolveRenderer: () => makeRenderer()
      })

      triggerBeforeInput(closeInput)

      expect(rendererSendMock).toHaveBeenCalledWith('ui:closeActiveTab', { sourceId: browserTabId })
      expect(rendererSendMock).not.toHaveBeenCalledWith('ui:closeFloatingItem', expect.anything())
    })

    it('drops auto-repeat index chords at the source for a floating guest', () => {
      setupGuestShortcutForwarding({
        browserTabId,
        guest: makeGuest(),
        resolveRenderer: () => makeRenderer(),
        resolveWorktreeId: () => 'global-floating-terminal'
      })

      const preventDefault = triggerBeforeInput({ ...workspaceIndexInput, isAutoRepeat: true })

      expect(preventDefault).not.toHaveBeenCalled()
      expect(rendererSendMock).not.toHaveBeenCalled()
    })
  })
})
