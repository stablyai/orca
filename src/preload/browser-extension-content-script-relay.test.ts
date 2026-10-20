import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  CONTENT_SCRIPT_RELAY_KEY,
  createContentScriptRelayBridge,
  installContentScriptRelayFilter
} from './browser-extension-content-script-relay'
import type { BrowserExtensionStorageSyncRelay } from './browser-extension-storage-sync'

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (reply: unknown) => void
) => unknown

/** Runs the filter from its source text, as contextBridge.executeInMainWorld does for pages. */
function install(answer?: BrowserExtensionStorageSyncRelay) {
  const listeners = new Set<Listener>()
  const onMessage = {
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener)
  }
  const chrome = { runtime: { id: 'ext', onMessage } }
  const browser = { runtime: { id: 'ext', onMessage } }
  const realm = { chrome, browser }
  runInNewContext(`(${installContentScriptRelayFilter.toString()})(answer)`, {
    ...realm,
    globalThis: realm,
    answer
  })
  // Delivers like Chromium: every native listener, first sendResponse wins.
  const dispatch = (message: unknown, sender: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      let kept = false
      for (const listener of listeners) {
        kept = listener(message, sender, resolve) === true || kept
      }
      if (!kept) {
        setTimeout(() => resolve('no reply'), 0)
      }
    })
  return { chrome, browser, listeners, dispatch }
}

const fromContentScript = { id: 'ext', tab: { id: 7 } }
const relayed = { [CONTENT_SCRIPT_RELAY_KEY]: { method: 'get', args: ['theme'] } }

describe('content script relay', () => {
  it('answers a content script’s relayed call in the worker and hides it from the extension', async () => {
    const answer = vi.fn(async () => ({ ok: true as const, value: { theme: 'dark' } }))
    const worker = install(answer)
    const seen: unknown[] = []
    const extensionListener = (message: unknown) => {
      seen.push(message)
    }
    worker.chrome.runtime.onMessage.addListener(extensionListener)

    await expect(worker.dispatch(relayed, fromContentScript)).resolves.toEqual({
      ok: true,
      value: { theme: 'dark' }
    })
    expect(answer).toHaveBeenCalledWith('get', ['theme'])
    await worker.dispatch({ hello: 1 }, fromContentScript)
    expect(seen).toEqual([{ hello: 1 }])
    expect(worker.browser.runtime.onMessage).toBe(worker.chrome.runtime.onMessage)

    worker.chrome.runtime.onMessage.removeListener(extensionListener)
    await worker.dispatch({ hello: 2 }, fromContentScript)
    expect(seen).toEqual([{ hello: 1 }])
  })

  it('answers only the extension’s own content scripts', async () => {
    const answer = vi.fn(async () => ({ ok: true as const, value: null }))
    const worker = install(answer)
    await expect(worker.dispatch(relayed, { id: 'ext' })).resolves.toBe('no reply')
    await expect(worker.dispatch(relayed, { id: 'other', tab: { id: 1 } })).resolves.toBe(
      'no reply'
    )
    expect(answer).not.toHaveBeenCalled()
  })

  it('only hides relayed calls in extension pages, leaving the answer to the worker', async () => {
    const page = install()
    const seen: unknown[] = []
    page.chrome.runtime.onMessage.addListener((message: unknown) => {
      seen.push(message)
      return true
    })
    await expect(page.dispatch(relayed, fromContentScript)).resolves.toBe('no reply')
    expect(seen).toEqual([])
  })

  it('sends a content script’s call to the worker and reports a missing worker as an error', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, value: 3 }))
    const bridge = createContentScriptRelayBridge(sendMessage)
    await expect(bridge.call('orcaStorageSync', 'getBytesInUse', [null])).resolves.toEqual({
      ok: true,
      value: 3
    })
    expect(sendMessage).toHaveBeenCalledWith({
      [CONTENT_SCRIPT_RELAY_KEY]: { method: 'getBytesInUse', args: [null] }
    })

    const unanswered = createContentScriptRelayBridge(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.')
    })
    await expect(unanswered.call('orcaStorageSync', 'get', [])).resolves.toEqual({
      ok: false,
      error: 'Could not establish connection. Receiving end does not exist.'
    })
  })
})
