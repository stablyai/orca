import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  installBrowserExtensionDocumentTargets,
  PRELOAD_DOCUMENT_TARGETS_NAMESPACE,
  PRELOAD_FIRST_DISCARDED_TAB_ID
} from './browser-extension-document-targets'

const DISCARDED_TAB = PRELOAD_FIRST_DISCARDED_TAB_ID + 3
const REPLACED_TAB = PRELOAD_FIRST_DISCARDED_TAB_ID + 4

const ORCA_TOP = 'A'.repeat(32)
const ORCA_AD = 'B'.repeat(32)
const CHROMIUM_TOP = 'C'.repeat(32)

/** Runs the installer from its source text, as contextBridge.executeInMainWorld does. */
function install(permissions: string[]) {
  const executeScript = vi.fn(
    async (injection: { target: Record<string, unknown>; func?: () => unknown }) =>
      (Array.isArray(injection.target.frameIds) ? injection.target.frameIds : [0]).map(
        (frameId: number) => ({ frameId, documentId: CHROMIUM_TOP, result: frameId })
      )
  )
  const insertCSS = vi.fn((_injection: unknown, callback?: () => void) => {
    callback?.()
    return callback ? undefined : Promise.resolve()
  })
  const sendMessage = vi.fn(async (_tabId: number, _message: unknown, _options?: unknown) => 'pong')
  const scripting = { executeScript, insertCSS, removeCSS: vi.fn(async () => {}) }
  const tabs = { sendMessage }
  const calls: unknown[][] = []
  const bridge = {
    call: async (namespace: string, method: string, args: unknown[]) => {
      // Main's tabs.get: a discarded tab, or (once replaced by its loaded guest) no tab.
      if (namespace === 'tabs' && method === 'get') {
        return args[0] === DISCARDED_TAB
          ? { ok: true as const, value: { id: DISCARDED_TAB, discarded: true } }
          : { ok: false as const, error: `No tab with id: ${String(args[0])}.` }
      }
      expect([namespace, method]).toEqual([PRELOAD_DOCUMENT_TARGETS_NAMESPACE, 'frames'])
      calls.push(args)
      return {
        ok: true as const,
        value: [
          { frameId: 0, documentId: ORCA_TOP },
          { frameId: 42, documentId: ORCA_AD }
        ]
      }
    },
    listen: () => {},
    onEvent: () => {},
    passesFilter: () => true
  }
  const runtime: { getManifest: () => unknown; lastError?: unknown } = {
    getManifest: () => ({ permissions })
  }
  const chrome = { runtime, scripting, tabs }
  // `browser` shares chrome's namespace objects, as Orca's installer mirrors them.
  const realm = { chrome, browser: { scripting, tabs }, Promise, Map, Set, Object, Array }
  runInNewContext(`(${installBrowserExtensionDocumentTargets.toString()})(bridge, first)`, {
    ...realm,
    globalThis: realm,
    bridge,
    first: PRELOAD_FIRST_DISCARDED_TAB_ID,
    Error
  })
  return { chrome, executeScript, insertCSS, sendMessage, calls }
}

describe('Orca documentIds in native scripting targets', () => {
  it("sends Orca's ids as frames and names results with them", async () => {
    const { chrome, executeScript, calls } = install(['webNavigation', 'scripting'])
    const results = await chrome.scripting.executeScript({
      target: { tabId: 3, documentIds: [ORCA_AD] },
      func: () => 1
    })
    expect(executeScript).toHaveBeenCalledTimes(1)
    expect(executeScript.mock.calls[0][0].target).toEqual({ tabId: 3, frameIds: [42] })
    expect(results).toEqual([{ frameId: 42, documentId: ORCA_AD, result: 42 }])
    expect(calls).toEqual([[3]])
  })

  it("passes Chromium's own ids through and keeps the callback form", async () => {
    const { chrome, executeScript, insertCSS, sendMessage } = install(['webRequest'])
    await chrome.scripting.executeScript({ target: { tabId: 3, documentIds: [CHROMIUM_TOP] } })
    expect(executeScript.mock.calls[0][0].target).toEqual({ tabId: 3, documentIds: [CHROMIUM_TOP] })

    const done = await new Promise((resolve) =>
      chrome.scripting.insertCSS(
        { target: { tabId: 3, documentIds: [ORCA_TOP] }, css: 'a{}' },
        () => resolve('called back')
      )
    )
    expect(done).toBe('called back')
    expect(insertCSS.mock.calls[0][0]).toEqual({ target: { tabId: 3, frameIds: [0] }, css: 'a{}' })

    await chrome.tabs.sendMessage(3, 'ping', { documentId: ORCA_AD })
    expect(sendMessage).toHaveBeenCalledWith(3, 'ping', { frameId: 42 })
  })

  it('calls the native functions directly when there is nothing to map', () => {
    const { chrome, executeScript, sendMessage } = install(['scripting'])
    void chrome.scripting.executeScript({ target: { tabId: 3, documentIds: [ORCA_TOP] } })
    void chrome.tabs.sendMessage(3, 'ping')
    expect(executeScript).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})

describe('calls to a discarded tab', () => {
  it("fail with Chrome's errors instead of reaching Electron", async () => {
    const { chrome, executeScript, sendMessage } = install(['scripting'])
    await expect(
      chrome.scripting.executeScript({ target: { tabId: DISCARDED_TAB }, func: () => 1 })
    ).rejects.toThrow('Cannot access contents of url ""')
    await expect(chrome.tabs.sendMessage(DISCARDED_TAB, 'ping')).rejects.toThrow(
      'Could not establish connection. Receiving end does not exist.'
    )
    const lastError = await new Promise((resolve) =>
      chrome.scripting.insertCSS({ target: { tabId: DISCARDED_TAB }, css: 'a{}' }, () =>
        resolve(chrome.runtime.lastError)
      )
    )
    expect(lastError).toEqual({ message: expect.stringContaining('Cannot access contents') })
    expect(chrome.runtime.lastError).toBeUndefined()
    expect(executeScript).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('leave a retired synthetic id to Electron, which reports no such tab', async () => {
    const { chrome, executeScript } = install(['scripting', 'webNavigation'])
    await chrome.scripting.executeScript({ target: { tabId: REPLACED_TAB } })
    expect(executeScript).toHaveBeenCalledTimes(1)
  })
})
