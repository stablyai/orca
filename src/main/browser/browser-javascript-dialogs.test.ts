import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import type { BrowserPagePromptRequest } from '../../shared/browser-page-prompt'
import {
  answerBrowserJavaScriptDialog,
  getBrowserJavaScriptDialog,
  installBrowserJavaScriptDialogs
} from './browser-javascript-dialogs'
import { respondToBrowserPagePrompt } from './browser-page-prompts'

type MockContents = Electron.WebContents & EventEmitter & { debugger: EventEmitter }

let nextGuestId = 300

function mockContents(id: number): MockContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog owner only reads id, URL, debugger events and the private dialog events.
  const contents = new EventEmitter() as MockContents
  Object.assign(contents, {
    id,
    debugger: new EventEmitter(),
    isDestroyed: () => false,
    getURL: () => 'https://shop.example/cart',
    send: vi.fn()
  })
  return contents
}

function setup() {
  const renderer = mockContents(1)
  const guest = mockContents(nextGuestId++)
  const electronSheet = vi.fn()
  guest.on('-run-dialog', electronSheet)
  installBrowserJavaScriptDialogs(guest, () => ({
    browserPageId: 'page-1',
    renderer
  }))
  const openDialog = (
    dialogType: string,
    messageText: string,
    defaultPromptText = '',
    frame?: { origin: string }
  ) => {
    const callback = vi.fn()
    guest.emit('-run-dialog', { frame, dialogType, messageText, defaultPromptText }, callback)
    return callback
  }
  const shownPrompts = (): BrowserPagePromptRequest[] =>
    vi
      .mocked(renderer.send)
      .mock.calls.filter(([channel]) => channel === 'browser:page-prompt-requested')
      .map(([, request]) => request)
  const closedPrompts = () =>
    vi
      .mocked(renderer.send)
      .mock.calls.filter(([channel]) => channel === 'browser:page-prompt-closed')
  return { renderer, guest, electronSheet, openDialog, shownPrompts, closedPrompts }
}

describe('browser JavaScript dialogs', () => {
  it('asks in the page prompt instead of Electron’s window-wide sheet', () => {
    const { guest, electronSheet, openDialog, shownPrompts } = setup()

    const callback = openDialog('confirm', 'Delete everything?')

    expect(electronSheet).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
    expect(getBrowserJavaScriptDialog(guest.id)).toEqual({
      type: 'confirm',
      message: 'Delete everything?',
      defaultPromptText: ''
    })
    expect(shownPrompts()).toEqual([
      expect.objectContaining({
        kind: 'javascript-dialog',
        details: {
          type: 'confirm',
          message: 'Delete everything?',
          defaultPromptText: '',
          origin: 'https://shop.example'
        }
      })
    ])
  })

  it('names an embedded page that asks, not the site around it', () => {
    const { openDialog, shownPrompts } = setup()

    openDialog('prompt', 'Re-enter your password', '', { origin: 'https://ads.example' })

    expect(shownPrompts()[0]?.details).toMatchObject({ origin: 'https://ads.example' })
  })

  it('takes an agent’s prompt answer and closes the page prompt', () => {
    const { guest, openDialog, closedPrompts } = setup()
    const callback = openDialog('prompt', 'Your name?', 'def')

    expect(answerBrowserJavaScriptDialog(guest.id, { accept: true, promptText: 'Ada' })).toBe(true)

    expect(callback).toHaveBeenCalledExactlyOnceWith(true, 'Ada')
    expect(closedPrompts()).toHaveLength(1)
    expect(getBrowserJavaScriptDialog(guest.id)).toBeNull()
    expect(answerBrowserJavaScriptDialog(guest.id, { accept: true, promptText: '' })).toBe(false)
  })

  it('answers the page with what the user chose in the page prompt', async () => {
    const { renderer, guest, openDialog, shownPrompts } = setup()
    const callback = openDialog('confirm', 'Leave?')

    await respondToBrowserPagePrompt(renderer, {
      requestId: shownPrompts()[0].requestId,
      answer: { accept: false, promptText: '' }
    })

    expect(callback).toHaveBeenCalledExactlyOnceWith(false, '')
    expect(getBrowserJavaScriptDialog(guest.id)).toBeNull()
  })

  it('turns away a second frame’s dialog and keeps the first one answerable', () => {
    const { guest, openDialog } = setup()
    const first = openDialog('confirm', 'Delete everything?')

    const second = openDialog('alert', 'From an iframe')

    expect(second).toHaveBeenCalledExactlyOnceWith(false, '')
    expect(getBrowserJavaScriptDialog(guest.id)?.message).toBe('Delete everything?')
    expect(answerBrowserJavaScriptDialog(guest.id, { accept: true, promptText: '' })).toBe(true)
    expect(first).toHaveBeenCalledExactlyOnceWith(true, '')
  })
})
