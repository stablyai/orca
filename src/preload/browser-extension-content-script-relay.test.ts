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
  const sendMessage = vi.fn(async (_message: unknown) => true)
  const chrome = { runtime: { id: 'ext', onMessage, sendMessage } }
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
  return { chrome, browser, listeners, dispatch, sendMessage }
}

const fromContentScript = { id: 'ext', tab: { id: 7 } }
const relayed = { [CONTENT_SCRIPT_RELAY_KEY]: { method: 'get', args: ['theme'] } }

describe('content script relay', () => {
  it('probes native document identity without exposing packets or adding receiving-end listeners', async () => {
    const receiver = install()
    const seen = vi.fn()
    const second = vi.fn()
    expect(receiver.listeners.size).toBe(0)
    receiver.chrome.runtime.onMessage.addListener(seen)
    receiver.chrome.runtime.onMessage.addListener(second)

    await expect(
      receiver.dispatch({ orcaDocumentTargetProbe: { token: 'private-probe' } }, { id: 'ext' })
    ).resolves.toBe(true)

    expect(receiver.sendMessage).toHaveBeenCalledExactlyOnceWith({
      orcaDocumentTargetProbe: { token: 'private-probe', response: true }
    })
    expect(seen).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(receiver.listeners.size).toBe(2)
    await receiver.dispatch(
      { orcaDocumentTargetProbe: { token: 'private-probe', response: true } },
      fromContentScript
    )
    expect(seen).not.toHaveBeenCalled()
    receiver.chrome.runtime.onMessage.removeListener(seen)
    receiver.chrome.runtime.onMessage.removeListener(second)
    expect(receiver.listeners.size).toBe(0)
  })

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
    expect(answer).toHaveBeenCalledWith('get', ['theme'], undefined)
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

  it('gives a listening content script the worker’s sync changes, except its own writes', async () => {
    const native = new Set<Listener>()
    const onMessage = {
      addListener: (listener: Listener) => native.add(listener),
      removeListener: (listener: Listener) => native.delete(listener)
    }
    const sendMessage = vi.fn(async (_message: unknown) => ({ ok: true, value: {} }))
    const bridge = createContentScriptRelayBridge(sendMessage, { id: 'ext', onMessage })
    const events: unknown[][] = []
    bridge.onEvent((...event) => events.push(event))
    const deliver = (message: unknown, sender: unknown) => {
      for (const listener of native) {
        listener(message, sender, () => {})
      }
    }
    const change = (from?: string) => ({
      [CONTENT_SCRIPT_RELAY_KEY]: { changes: { theme: { newValue: 'dark' } }, from }
    })
    expect(native.size).toBe(0)
    bridge.listen('orcaStorageSync', 'onChanged', true)

    await bridge.call('orcaStorageSync', 'set', [{ theme: 'light' }])
    const [sent] = sendMessage.mock.calls[0]
    const ownId =
      isRecord(sent) && isRecord(sent[CONTENT_SCRIPT_RELAY_KEY])
        ? sent[CONTENT_SCRIPT_RELAY_KEY].from
        : null
    expect(typeof ownId).toBe('string')
    deliver(change(String(ownId)), { id: 'ext' })
    deliver(change(), { id: 'other-extension' })
    deliver(change('another-frame'), { id: 'ext' })
    expect(events).toEqual([['orcaStorageSync', 'onChanged', [{ theme: { newValue: 'dark' } }]]])

    bridge.listen('orcaStorageSync', 'onChanged', false)
    expect(native.size).toBe(0)
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
