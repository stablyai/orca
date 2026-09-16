import type { App } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  installContextMenuWindowActivation,
  shouldActivateWindowForContextMenuInput,
  type ContextMenuActivationInput,
  type ContextMenuInputEventTarget,
  type ContextMenuWindowActivationOptions
} from './context-menu-window-activation'

function makeFakeWebContents(): ContextMenuInputEventTarget & {
  emitInput: (input: ContextMenuActivationInput) => void
} {
  const listeners: ((event: unknown, input: ContextMenuActivationInput) => void)[] = []
  return {
    on: (channel, listener) => {
      if (channel === 'input-event') {
        listeners.push(listener)
      }
    },
    emitInput: (input) => {
      for (const listener of listeners) {
        listener({}, input)
      }
    }
  }
}

function makeFakeWindow(
  options: { focused?: boolean; destroyed?: boolean } = {}
): ContextMenuWindowActivationOptions['window'] & { focusCalls: ReturnType<typeof vi.fn> } {
  const focus = vi.fn()
  return {
    isFocused: () => options.focused ?? false,
    isDestroyed: () => options.destroyed ?? false,
    focus,
    focusCalls: focus
  }
}

function makeFakeApp(): Pick<App, 'focus'> & { focusCalls: ReturnType<typeof vi.fn> } {
  const focus = vi.fn()
  return { focus, focusCalls: focus }
}

describe('shouldActivateWindowForContextMenuInput', () => {
  it('activates on a right mouse press in an unfocused window', () => {
    expect(
      shouldActivateWindowForContextMenuInput(
        { type: 'mouseDown', button: 'right' },
        false,
        'darwin'
      )
    ).toBe(true)
  })

  it('ignores a right mouse press when the window already has focus', () => {
    expect(
      shouldActivateWindowForContextMenuInput(
        { type: 'mouseDown', button: 'right' },
        true,
        'darwin'
      )
    ).toBe(false)
  })

  it('ignores a left mouse press, which macOS already turns into an activating click', () => {
    expect(
      shouldActivateWindowForContextMenuInput(
        { type: 'mouseDown', button: 'left' },
        false,
        'darwin'
      )
    ).toBe(false)
  })

  it('activates on a macOS control-click, which also opens the context menu', () => {
    expect(
      shouldActivateWindowForContextMenuInput(
        { type: 'mouseDown', button: 'left', modifiers: ['control'] },
        false,
        'darwin'
      )
    ).toBe(true)
  })

  it('ignores a control-click off macOS, where it is not a context-menu gesture', () => {
    expect(
      shouldActivateWindowForContextMenuInput(
        { type: 'mouseDown', button: 'left', modifiers: ['control'] },
        false,
        'win32'
      )
    ).toBe(false)
  })

  it('ignores non-press input such as pointer moves', () => {
    expect(
      shouldActivateWindowForContextMenuInput(
        { type: 'mouseMove', button: 'right' },
        false,
        'darwin'
      )
    ).toBe(false)
  })
})

describe('installContextMenuWindowActivation', () => {
  it('focuses the app and the window on a right press while unfocused', () => {
    const webContents = makeFakeWebContents()
    const window = makeFakeWindow({ focused: false })
    const app = makeFakeApp()

    installContextMenuWindowActivation({ webContents, window, app, platform: 'darwin' })
    webContents.emitInput({ type: 'mouseDown', button: 'right' })

    expect(app.focusCalls).toHaveBeenCalledWith({ steal: true })
    expect(window.focusCalls).toHaveBeenCalledTimes(1)
  })

  it('leaves a focused window alone', () => {
    const webContents = makeFakeWebContents()
    const window = makeFakeWindow({ focused: true })
    const app = makeFakeApp()

    installContextMenuWindowActivation({ webContents, window, app, platform: 'darwin' })
    webContents.emitInput({ type: 'mouseDown', button: 'right' })

    expect(app.focusCalls).not.toHaveBeenCalled()
    expect(window.focusCalls).not.toHaveBeenCalled()
  })

  it('does not touch a destroyed window', () => {
    const webContents = makeFakeWebContents()
    const window = makeFakeWindow({ focused: false, destroyed: true })
    const app = makeFakeApp()

    installContextMenuWindowActivation({ webContents, window, app, platform: 'darwin' })
    webContents.emitInput({ type: 'mouseDown', button: 'right' })

    expect(app.focusCalls).not.toHaveBeenCalled()
    expect(window.focusCalls).not.toHaveBeenCalled()
  })

  it('takes no foreground during a background launch', () => {
    const webContents = makeFakeWebContents()
    const window = makeFakeWindow({ focused: false })
    const app = makeFakeApp()

    installContextMenuWindowActivation({
      webContents,
      window,
      app,
      platform: 'darwin',
      env: { ORCA_BACKGROUND_LAUNCH: '1' }
    })
    webContents.emitInput({ type: 'mouseDown', button: 'right' })

    expect(app.focusCalls).not.toHaveBeenCalled()
    expect(window.focusCalls).not.toHaveBeenCalled()
  })

  it('activates on a foreground launch', () => {
    const webContents = makeFakeWebContents()
    const window = makeFakeWindow({ focused: false })
    const app = makeFakeApp()

    installContextMenuWindowActivation({
      webContents,
      window,
      app,
      platform: 'darwin',
      env: { ORCA_E2E_FOREGROUND: '1' }
    })
    webContents.emitInput({ type: 'mouseDown', button: 'right' })

    expect(app.focusCalls).toHaveBeenCalledWith({ steal: true })
    expect(window.focusCalls).toHaveBeenCalledTimes(1)
  })

  it('still focuses the window when app.focus throws', () => {
    const webContents = makeFakeWebContents()
    const window = makeFakeWindow({ focused: false })
    const app = makeFakeApp()
    app.focusCalls.mockImplementation(() => {
      throw new Error('no app focus')
    })

    installContextMenuWindowActivation({ webContents, window, app, platform: 'darwin' })
    webContents.emitInput({ type: 'mouseDown', button: 'right' })

    expect(window.focusCalls).toHaveBeenCalledTimes(1)
  })
})
