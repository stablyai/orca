// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { createTerminalDocumentScope } from './document-scope'
import { startMessageBridge, stopMessageBridge } from './message-bridge'
import { startTerminalDocument } from './create-terminal-document'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html/document-markup'

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
afterEach(() => {
  vi.useRealTimers()
  if (originalFonts) {
    Object.defineProperty(document, 'fonts', originalFonts)
  } else {
    Reflect.deleteProperty(document, 'fonts')
  }
})

function pendingFonts() {
  let finish = () => {}
  let fail = () => {}
  const loaded = new Promise<FontFace[]>((resolve, reject) => {
    finish = () => resolve([])
    fail = () => reject(new Error('font unavailable'))
  })
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { check: () => false, load: () => loaded }
  })
  const postToHost = vi.fn()
  const scope = createTerminalDocumentScope({
    postToHost,
    hasEngine: () => true,
    start: () => ({ shown: false, textScale: 1 }),
    installHostTransport: () => () => {}
  })
  return { fail, finish, loaded, postToHost, scope }
}

describe('the terminal waits for its bundled glyphs', () => {
  it('starts once by the deadline if font loading never settles', async () => {
    vi.useFakeTimers()
    const fonts = pendingFonts()
    const ready = startMessageBridge(fonts.scope)
    await vi.advanceTimersByTimeAsync(1999)
    expect(fonts.postToHost).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await ready
    expect(fonts.postToHost).toHaveBeenCalledExactlyOnceWith({ type: 'web-ready', cellBox: null })
    expect(vi.getTimerCount()).toBe(0)
    stopMessageBridge(fonts.scope)
  })

  it('clears the fallback atlas when a timed-out font arrives without repeating readiness', async () => {
    vi.useFakeTimers()
    const fonts = pendingFonts()
    const terminal = terminalDocumentDouble().terminal
    const refresh = vi.spyOn(terminal, 'refresh')
    const clearTextureAtlas = vi.fn()
    fonts.scope.term = terminal
    fonts.scope.webglAddon = { dispose() {}, clearTextureAtlas }
    startMessageBridge(fonts.scope)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fonts.postToHost).toHaveBeenCalledOnce()
    fonts.finish()
    await fonts.loaded
    expect(clearTextureAtlas).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledExactlyOnceWith(0, 23)
    expect(fonts.postToHost).toHaveBeenCalledOnce()
    expect(fonts.scope.cancelFontReadiness).toBeNull()
    stopMessageBridge(fonts.scope)
  })

  it('cancels the deadline and ignores late font completion after disposal', async () => {
    vi.useFakeTimers()
    const fonts = pendingFonts()
    const terminal = terminalDocumentDouble().terminal
    const refresh = vi.spyOn(terminal, 'refresh')
    const clearTextureAtlas = vi.fn()
    fonts.scope.term = terminal
    fonts.scope.webglAddon = { dispose() {}, clearTextureAtlas }
    const ready = startMessageBridge(fonts.scope)
    stopMessageBridge(fonts.scope)
    await ready
    expect(vi.getTimerCount()).toBe(0)
    fonts.finish()
    await fonts.loaded
    await vi.advanceTimersByTimeAsync(2000)
    expect(fonts.postToHost).not.toHaveBeenCalled()
    expect(clearTextureAtlas).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('also ignores font completion after a timed-out document is disposed', async () => {
    vi.useFakeTimers()
    const fonts = pendingFonts()
    const clearTextureAtlas = vi.fn()
    fonts.scope.webglAddon = { dispose() {}, clearTextureAtlas }
    startMessageBridge(fonts.scope)
    await vi.advanceTimersByTimeAsync(2000)
    stopMessageBridge(fonts.scope)
    fonts.finish()
    await fonts.loaded
    expect(clearTextureAtlas).not.toHaveBeenCalled()
    expect(fonts.postToHost).toHaveBeenCalledOnce()
  })

  it('takes back its deadline after rejection and ignores a later deadline', async () => {
    vi.useFakeTimers()
    const fonts = pendingFonts()
    const ready = startMessageBridge(fonts.scope)
    fonts.fail()
    await ready
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fonts.postToHost).toHaveBeenCalledExactlyOnceWith({ type: 'web-ready', cellBox: null })
    stopMessageBridge(fonts.scope)
  })

  it('unwinds failed startup reached by the font deadline', async () => {
    vi.useFakeTimers()
    const fonts = pendingFonts()
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    fonts.scope.postToHost = (message) => {
      if (message.type === 'web-ready') {
        throw new Error('timed-out readiness transport failed')
      }
      fonts.postToHost(message)
    }
    const removeTransport = vi.fn()
    fonts.scope.installHostTransport = () => removeTransport
    startTerminalDocument(fonts.scope)
    await vi.advanceTimersByTimeAsync(2000)
    expect(removeTransport).toHaveBeenCalledOnce()
    expect(fonts.scope.framesStopped).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(fonts.postToHost).toHaveBeenCalledWith({
      type: 'error',
      fatal: true,
      message: expect.stringContaining('timed-out readiness transport failed')
    })
    fonts.finish()
    await fonts.loaded
    expect(fonts.postToHost).toHaveBeenCalledOnce()
  })

  it('withholds readiness until the font can paint the first terminal snapshot', async () => {
    const fonts = pendingFonts()
    startMessageBridge(fonts.scope)
    expect(fonts.postToHost).not.toHaveBeenCalled()
    fonts.finish()
    await fonts.loaded
    expect(fonts.postToHost).toHaveBeenCalledWith({ type: 'web-ready', cellBox: null })
    stopMessageBridge(fonts.scope)
  })

  it('still starts the terminal if font decoding fails', async () => {
    const fonts = pendingFonts()
    startMessageBridge(fonts.scope)
    fonts.fail()
    await fonts.loaded.catch(() => {})
    expect(fonts.postToHost).toHaveBeenCalledWith({ type: 'web-ready', cellBox: null })
    stopMessageBridge(fonts.scope)
  })

  it('unwinds the document and reports an error if deferred startup fails', async () => {
    const fonts = pendingFonts()
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    fonts.scope.postToHost = (message) => {
      if (message.type === 'web-ready') {
        throw new Error('readiness transport failed')
      }
      fonts.postToHost(message)
    }
    const removeTransport = vi.fn()
    fonts.scope.installHostTransport = () => removeTransport
    startTerminalDocument(fonts.scope)
    fonts.finish()
    await fonts.loaded
    await Promise.resolve()
    expect(removeTransport).toHaveBeenCalledOnce()
    expect(fonts.scope.framesStopped).toBe(true)
    expect(fonts.postToHost).toHaveBeenCalledWith({
      type: 'error',
      fatal: true,
      message: expect.stringContaining('readiness transport failed')
    })
  })

  it('does not revive a document stopped during the font load', async () => {
    const fonts = pendingFonts()
    startMessageBridge(fonts.scope)
    stopMessageBridge(fonts.scope)
    fonts.finish()
    await fonts.loaded
    expect(fonts.postToHost).not.toHaveBeenCalled()
  })
})
