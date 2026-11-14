// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from '../document-scope'
import { startMessageBridge, stopMessageBridge } from './message-bridge'
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
})
