import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
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
const CHROMIUM_AD = 'D'.repeat(32)

type NativeListener = (message: unknown, sender: unknown, respond: (value: unknown) => void) => void

function navigatingDocumentTarget(navigateOnLookup = 1) {
  let current = 'old-document'
  const delivered: string[] = []
  const listeners = new Set<NativeListener>()
  const runtime = {
    id: 'extension',
    getManifest: () => ({ permissions: ['webNavigation', 'scripting'] }),
    onMessage: {
      addListener: (listener: NativeListener) => listeners.add(listener),
      removeListener: (listener: NativeListener) => listeners.delete(listener)
    }
  }
  const chrome = {
    runtime,
    scripting: {
      executeScript: async (injection: {
        target: { documentIds?: string[]; tabId: number }
        func?: () => unknown
      }) => {
        if (injection.target.documentIds?.some((id) => id !== current)) {
          throw new Error('No matching document')
        }
        const result = injection.func?.()
        return [{ frameId: 0, documentId: current, result }]
      }
    },
    tabs: {
      sendMessage: async (_tabId: number, message: unknown, options?: { documentId?: string }) => {
        if (options?.documentId && options.documentId !== current) {
          throw new Error('No matching document')
        }
        if (typeof message === 'string') {
          delivered.push(current)
          return 'received'
        }
        for (const listener of listeners) {
          listener(
            {
              orcaDocumentTargetProbe: {
                ...(message &&
                typeof message === 'object' &&
                'orcaDocumentTargetProbe' in message &&
                message.orcaDocumentTargetProbe &&
                typeof message.orcaDocumentTargetProbe === 'object'
                  ? message.orcaDocumentTargetProbe
                  : {}),
                response: true
              }
            },
            { id: 'extension', tab: { id: 3 }, frameId: 0, documentId: current },
            () => {}
          )
        }
        return true
      }
    }
  }
  let lookups = 0
  const bridge = {
    call: async () => {
      const value = [{ frameId: 0, documentId: current }]
      if (++lookups === navigateOnLookup) {
        current = 'new-document'
      }
      return { ok: true as const, value }
    },
    listen: () => {},
    onEvent: () => {},
    passesFilter: () => true
  }
  const realm = { chrome, crypto: webcrypto, setTimeout, clearTimeout }
  runInNewContext(`(${installBrowserExtensionDocumentTargets.toString()})(bridge, first)`, {
    ...realm,
    globalThis: realm,
    bridge,
    first: PRELOAD_FIRST_DISCARDED_TAB_ID
  })
  return { chrome, delivered, listeners }
}

/** Runs the installer from its source text, as contextBridge.executeInMainWorld does. */
function install(permissions: string[], nativeScripting = true) {
  const nativeListeners = new Set<NativeListener>()
  const executeScript = vi.fn(
    async (injection: { target: Record<string, unknown>; func?: () => unknown }) => {
      const frameIds = Array.isArray(injection.target.frameIds)
        ? injection.target.frameIds
        : Array.isArray(injection.target.documentIds)
          ? injection.target.documentIds.map((id) => (id === CHROMIUM_AD ? 42 : 0))
          : [0]
      return frameIds.map((frameId: number) => ({
        frameId,
        documentId: frameId === 42 ? CHROMIUM_AD : CHROMIUM_TOP,
        result: frameId
      }))
    }
  )
  const insertCSS = vi.fn((_injection: unknown, callback?: () => void) => {
    callback?.()
    return callback ? undefined : Promise.resolve()
  })
  const sendMessage = vi.fn(
    async (
      tabId: number,
      message: unknown,
      options?: { frameId?: number; documentId?: string },
      _callback?: () => void
    ): Promise<string | boolean> => {
      if (message && typeof message === 'object' && 'orcaDocumentTargetProbe' in message) {
        const frameId = options?.frameId ?? 0
        const probe = message.orcaDocumentTargetProbe
        for (const listener of nativeListeners) {
          listener(
            {
              orcaDocumentTargetProbe: {
                ...(typeof probe === 'object' ? probe : {}),
                response: true
              }
            },
            {
              id: 'extension',
              tab: { id: tabId },
              frameId,
              documentId: frameId === 42 ? CHROMIUM_AD : CHROMIUM_TOP
            },
            () => {}
          )
        }
        return true
      }
      return 'pong'
    }
  )
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
  const runtime: {
    id: string
    getManifest: () => unknown
    lastError?: unknown
    onMessage: {
      addListener: (listener: NativeListener) => void
      removeListener: (listener: NativeListener) => void
    }
  } = {
    id: 'extension',
    getManifest: () => ({ permissions }),
    onMessage: {
      addListener: (listener) => {
        nativeListeners.add(listener)
      },
      removeListener: (listener) => {
        nativeListeners.delete(listener)
      }
    }
  }
  const chrome = { runtime, scripting, tabs }
  // `browser` shares chrome's namespace objects, as Orca's installer mirrors them.
  const realm = {
    chrome: nativeScripting ? chrome : { runtime, tabs },
    browser: nativeScripting ? { scripting, tabs } : { tabs },
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Set,
    Object,
    Array
  }
  runInNewContext(`(${installBrowserExtensionDocumentTargets.toString()})(bridge, first)`, {
    ...realm,
    globalThis: realm,
    bridge,
    first: PRELOAD_FIRST_DISCARDED_TAB_ID,
    Error
  })
  return { chrome, executeScript, insertCSS, sendMessage, calls, nativeListeners }
}

describe('Orca documentIds in native scripting targets', () => {
  it.each([1, 2])(
    'rejects script navigation at discovery snapshot %i before executing user code',
    async (snapshot) => {
      const { chrome } = navigatingDocumentTarget(snapshot)
      const userCode = vi.fn()

      await expect(
        chrome.scripting.executeScript({
          target: { documentIds: ['old-document'], tabId: 3 },
          func: userCode
        })
      ).rejects.toThrow(/document/i)

      expect(userCode).not.toHaveBeenCalled()
    }
  )

  it.each([1, 2])(
    'rejects message navigation at discovery snapshot %i before delivering the payload',
    async (snapshot) => {
      const { chrome, delivered, listeners } = navigatingDocumentTarget(snapshot)

      await expect(
        chrome.tabs.sendMessage(3, 'document-specific secret', {
          documentId: 'old-document'
        })
      ).rejects.toThrow(/document/i)

      expect(delivered).toEqual([])
      expect(listeners.size).toBe(0)
    }
  )

  it("preserves a native document constraint for Orca's document ids", async () => {
    const { chrome, executeScript, calls } = install(['webNavigation', 'scripting'])
    const results = await chrome.scripting.executeScript({
      target: { tabId: 3, documentIds: [ORCA_AD] },
      func: () => 1
    })
    expect(executeScript).toHaveBeenCalledTimes(2)
    expect(executeScript.mock.calls[1][0].target).toEqual({ tabId: 3, documentIds: [CHROMIUM_AD] })
    expect(results).toEqual([{ frameId: 42, documentId: ORCA_AD, result: 42 }])
    expect(calls).toEqual([[3], [3]])
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
    expect(insertCSS.mock.calls[0][0]).toEqual({
      target: { tabId: 3, documentIds: [CHROMIUM_TOP] },
      css: 'a{}'
    })

    await chrome.tabs.sendMessage(3, 'ping', { documentId: ORCA_AD })
    expect(sendMessage).toHaveBeenCalledWith(3, 'ping', { documentId: CHROMIUM_AD })
  })

  it.each([false, true])(
    'resolves message recipients without requiring scripting even when the namespace exists: %s',
    async (nativeScripting) => {
      const { chrome, executeScript, sendMessage, nativeListeners } = install(
        ['webNavigation'],
        nativeScripting
      )
      executeScript.mockRejectedValueOnce(new Error('Requires scripting permission'))

      await expect(chrome.tabs.sendMessage(3, 'ping', { documentId: ORCA_AD })).resolves.toBe(
        'pong'
      )

      expect(sendMessage).toHaveBeenLastCalledWith(3, 'ping', { documentId: CHROMIUM_AD })
      expect(executeScript).toHaveBeenCalledTimes(nativeScripting ? 1 : 0)
      expect(nativeListeners.size).toBe(0)
    }
  )

  it('reaches dynamically injected message listeners that do not handle private probes', async () => {
    const { chrome, sendMessage, nativeListeners } = install(['webNavigation', 'scripting'])
    sendMessage.mockImplementationOnce(async (_tabId, message) => {
      if (typeof message !== 'string') {
        throw new Error('Unexpected private packet')
      }
      return 'dynamic receiver response'
    })

    await expect(
      chrome.tabs.sendMessage(3, 'real payload', { documentId: ORCA_TOP })
    ).resolves.toBe('dynamic receiver response')

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(3, 'real payload', { documentId: CHROMIUM_TOP })
    expect(nativeListeners.size).toBe(0)
  })

  it('never labels an unexpected native document as the requested Orca document', async () => {
    const { chrome, executeScript } = install(['webNavigation', 'scripting'])
    executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: CHROMIUM_TOP, result: 0 }])
    executeScript.mockResolvedValueOnce([
      { frameId: 0, documentId: 'replacement-document', result: 1 }
    ])

    await expect(
      chrome.scripting.executeScript({
        target: { tabId: 3, documentIds: [ORCA_TOP] }
      })
    ).resolves.toEqual([{ frameId: 0, documentId: 'replacement-document', result: 1 }])
  })

  it('cleans up failed identity probes and reports callback errors without delivering the payload', async () => {
    const { chrome, sendMessage, nativeListeners } = install(['webNavigation'], false)
    sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'))
    const callback = vi.fn()
    const error = await new Promise((resolve) => {
      chrome.tabs.sendMessage(3, 'private payload', { documentId: ORCA_TOP }, () => {
        callback()
        resolve(chrome.runtime.lastError)
      })
    })

    expect(error).toEqual({ message: 'Receiving end does not exist' })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(chrome.runtime.lastError).toBeUndefined()
    expect(nativeListeners.size).toBe(0)
  })

  it('keeps native result identities for untargeted executions', async () => {
    const { chrome, calls } = install(['webNavigation', 'scripting'])

    await expect(chrome.scripting.executeScript({ target: { tabId: 3 } })).resolves.toEqual([
      { frameId: 0, documentId: CHROMIUM_TOP, result: 0 }
    ])

    expect(calls).toEqual([])
  })

  it('calls the native functions directly when there is nothing to map', () => {
    const { chrome, executeScript, sendMessage } = install(['scripting'])
    void chrome.scripting.executeScript({ target: { tabId: 3 } })
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
