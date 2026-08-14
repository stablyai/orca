import type { App, BrowserWindow, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  installContextMenuWindowActivation,
  shouldActivateWindowForContextMenuInput
} from './context-menu-window-activation'

function makeFakeWebContents(): Pick<WebContents, 'on'> & {
  emitInput: (input: unknown) => void
} {
  const listeners: ((event: unknown, input: unknown) => void)[] = []
  return {
    on: vi.fn((channel: string, listener: (event: unknown, input: unknown) => void) => {
      if (channel === 'input-event') {
        listeners.push(listener)
      }
      return undefined as never
    }),
    emitInput: (input: unknown) => {
      for (const listener of listeners) {
        listener({}, input)
      }
    }
  } as unknown as Pick<WebContents, 'on'> & { emitInput: (input: unknown) => void }
}

function makeFakeWindow(options: { focused?: boolean; destroyed?: boolean } = {}): BrowserWindow & {
  focusCalls: ReturnType<typeof vi.fn>
} {
  const focus = vi.fn()
  return {
    isFocused: vi.fn(() => options.focused ?? false),
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    focus,
    focusCalls: focus
  } as unknown as BrowserWindow & { focusCalls: ReturnType<typeof vi.fn> }
}

function makeFakeApp(): Pick<App, 'focus'> & { focusCalls: ReturnType<typeof vi.fn> } {
  const focus = vi.fn()
  return { focus, focusCalls: focus } as unknown as Pick<App, 'focus'> & {
    focusCalls: ReturnType<typeof vi.fn>
  }
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
