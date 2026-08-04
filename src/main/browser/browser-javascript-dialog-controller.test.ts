import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import {
  BROWSER_JAVASCRIPT_DIALOG_MESSAGE_MAX_CHARS,
  BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS
} from '../../shared/browser-javascript-dialog'
import { installBrowserJavaScriptDialogController } from './browser-javascript-dialog-controller'

function createGuest() {
  const events = new EventEmitter()
  const debuggerEvents = new EventEmitter()
  return {
    events,
    debuggerEvents,
    guest: Object.assign(events, {
      debugger: debuggerEvents,
      isDestroyed: vi.fn(() => false)
    }) as unknown as Electron.WebContents
  }
}

function dialogInfo(overrides: Record<string, unknown> = {}) {
  return {
    frame: { origin: 'https://example.com', url: 'https://example.com/path?secret=1' },
    dialogType: 'confirm',
    messageText: 'Continue?',
    defaultPromptText: '',
    ...overrides
  }
}

describe('browser JavaScript dialog controller', () => {
  it('replaces Electron native dialogs while preserving the blocking callback', () => {
    const { events, guest } = createGuest()
    const nativeListener = vi.fn()
    const callback = vi.fn()
    const onOpened = vi.fn()
    const onClosed = vi.fn()
    events.on('-run-dialog', nativeListener)

    const controller = installBrowserJavaScriptDialogController(guest, { onOpened, onClosed })
    events.emit('-run-dialog', dialogInfo(), callback)

    expect(nativeListener).not.toHaveBeenCalled()
    const request = onOpened.mock.calls[0][0]
    expect(request).toMatchObject({
      dialogType: 'confirm',
      message: 'Continue?',
      frameOrigin: 'https://example.com'
    })
    expect(controller.respond(request.dialogId, true)).toBe(true)
    expect(callback).toHaveBeenCalledWith(true, '')
    expect(onClosed).toHaveBeenCalledWith(request)

    controller.dispose()
    events.emit('-run-dialog', dialogInfo(), vi.fn())
    expect(nativeListener).toHaveBeenCalledOnce()
  })

  it('clears scoped UI when CDP resolves the dialog', () => {
    const { events, debuggerEvents, guest } = createGuest()
    const callback = vi.fn()
    const onOpened = vi.fn()
    const onClosed = vi.fn()
    const controller = installBrowserJavaScriptDialogController(guest, { onOpened, onClosed })

    events.emit('-run-dialog', dialogInfo(), callback)
    const request = onOpened.mock.calls[0][0]
    debuggerEvents.emit('message', {}, 'Page.javascriptDialogClosed', {})

    expect(onClosed).toHaveBeenCalledWith(request)
    expect(callback).not.toHaveBeenCalled()
    expect(controller.getPending()).toBeNull()
    expect(controller.respond(request.dialogId, false)).toBe(false)
  })

  it('clears scoped UI when Chromium cancels dialogs', () => {
    const { events, guest } = createGuest()
    const callback = vi.fn()
    const onClosed = vi.fn()
    const controller = installBrowserJavaScriptDialogController(guest, {
      onOpened: vi.fn(),
      onClosed
    })

    events.emit('-run-dialog', dialogInfo(), callback)
    events.emit('-cancel-dialogs')

    expect(onClosed).toHaveBeenCalledOnce()
    expect(callback).not.toHaveBeenCalled()
    expect(controller.getPending()).toBeNull()
  })

  it('rejects a pending dialog on dispose even if the close notification throws', () => {
    const { events, guest } = createGuest()
    const callback = vi.fn()
    const controller = installBrowserJavaScriptDialogController(guest, {
      onOpened: vi.fn(),
      onClosed: vi.fn(() => {
        throw new Error('renderer closed')
      })
    })

    events.emit('-run-dialog', dialogInfo(), callback)
    controller.dispose()

    expect(callback).toHaveBeenCalledWith(false, '')
  })

  it('resolves a response even if the close notification throws', () => {
    const { events, guest } = createGuest()
    const callback = vi.fn()
    const onOpened = vi.fn()
    const controller = installBrowserJavaScriptDialogController(guest, {
      onOpened,
      onClosed: vi.fn(() => {
        throw new Error('renderer closed')
      })
    })

    events.emit('-run-dialog', dialogInfo(), callback)
    const request = onOpened.mock.calls[0][0]

    expect(controller.respond(request.dialogId, true)).toBe(true)
    expect(callback).toHaveBeenCalledWith(true, '')
  })

  it('bounds untrusted dialog and prompt text without splitting Unicode code points', () => {
    const { events, guest } = createGuest()
    const callback = vi.fn()
    const onOpened = vi.fn()
    const controller = installBrowserJavaScriptDialogController(guest, {
      onOpened,
      onClosed: vi.fn()
    })

    events.emit(
      '-run-dialog',
      dialogInfo({
        dialogType: 'prompt',
        messageText: `${'m'.repeat(BROWSER_JAVASCRIPT_DIALOG_MESSAGE_MAX_CHARS - 2)}🙂overflow`,
        defaultPromptText: `${'d'.repeat(BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS - 2)}🙂overflow`
      }),
      callback
    )
    const request = onOpened.mock.calls[0][0]

    expect([...request.message]).toHaveLength(BROWSER_JAVASCRIPT_DIALOG_MESSAGE_MAX_CHARS)
    expect([...request.defaultPromptText]).toHaveLength(BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS)
    expect(request.message.endsWith('🙂…')).toBe(true)
    expect(request.defaultPromptText.endsWith('🙂…')).toBe(true)
    expect(
      controller.respond(
        request.dialogId,
        true,
        'p'.repeat(BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS + 10)
      )
    ).toBe(true)
    expect(callback.mock.calls[0][1]).toHaveLength(BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS)
  })
})
