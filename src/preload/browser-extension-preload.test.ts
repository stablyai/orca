import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PRELOAD_BROWSER_EXTENSION_EVENT_CHANNEL } from './browser/extensions/api/browser-extension-api-surface'

const source = buildSync({
  entryPoints: [fileURLToPath(new URL('./browser-extension-preload.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  write: false
}).outputFiles[0].text

function loadFrame(contextIsolated = true, opaque = false) {
  const nativeSet = vi.fn(async (_items: unknown) => undefined)
  const nativeGet = vi.fn(async () => ({ sentinel: 'native-only' }))
  const nativeScript = vi.fn(async (script: { files?: string[] }) => [
    {
      frameId: 0,
      documentId: 'native-document',
      result: script.files ? { orcaPrefix: 'initialized' } : undefined
    }
  ])
  const nativeMessage = vi.fn(
    async (_tab: number, _message: unknown, _options?: unknown) => 'received'
  )
  const chrome = {
    runtime: { getManifest: () => ({ permissions: ['storage', 'scripting'] }) },
    storage: { session: { set: nativeSet, get: nativeGet } },
    scripting: { executeScript: nativeScript },
    tabs: { sendMessage: nativeMessage }
  }
  const page = createContext({ chrome, console })
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const invoke = vi.fn(async (_channel: string, request: Record<string, unknown>) => {
    if (request.namespace === 'orcaDocumentTargets') {
      return {
        ok: true,
        value:
          request.method === 'prefix'
            ? { file: 'own-prefix.js', execution: 'own-generation' }
            : [{ frameId: 0, documentId: 'orca-document' }]
      }
    }
    if (request.namespace === 'orcaStorageSession' && request.type === 'call') {
      return {
        ok: true,
        value:
          request.method === 'set'
            ? { sentinel: { newValue: 'canonical' } }
            : { sentinel: 'canonical' }
      }
    }
    return { ok: true, value: null }
  })
  runInNewContext(source, {
    process: { contextIsolated, isMainFrame: false },
    location: { href: 'chrome-extension://example/manifest.json?orca-native-page=1' },
    origin: opaque ? 'null' : 'chrome-extension://example',
    navigator: { userActivation: { isActive: false } },
    require: () => ({
      ipcRenderer: {
        invoke,
        on: (channel: string, callback: (event: unknown, payload: unknown) => void) =>
          listeners.set(channel, callback)
      },
      contextBridge: {
        executeInMainWorld: ({
          func,
          args = []
        }: {
          func: (...args: unknown[]) => unknown
          args?: unknown[]
        }) => {
          page.args = args
          return runInContext(`(${func.toString()})(...args)`, page)
        }
      }
    })
  })
  return { chrome, invoke, nativeGet, nativeSet, nativeScript, nativeMessage, listeners }
}

describe('extension frame preload authority', () => {
  it('routes an isolated manifest-marker frame through canonical storage and events', async () => {
    const { chrome, invoke, nativeGet, nativeSet, listeners } = loadFrame()
    const changed = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The bundled preload installs the onChanged event exercised by this fixture.
    const session = chrome.storage.session as typeof chrome.storage.session & {
      onChanged: { addListener: (listener: typeof changed) => void }
    }
    session.onChanged.addListener(changed)
    await session.set({ sentinel: 'canonical' })
    expect(await session.get()).toEqual({ sentinel: 'canonical' })
    expect(nativeSet).not.toHaveBeenCalled()
    expect(nativeGet).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith(
      expect.any(String),
      {
        type: 'call',
        namespace: 'orcaStorageSession',
        method: 'set',
        args: [{ sentinel: 'canonical' }]
      },
      false
    )
    expect(changed.mock.calls).toEqual([[{ sentinel: { newValue: 'canonical' } }]])
    listeners.get(PRELOAD_BROWSER_EXTENSION_EVENT_CHANNEL)?.(null, {
      namespace: 'orcaStorageSession',
      event: 'onChanged',
      args: [{ sentinel: { oldValue: 'canonical', newValue: 'other-frame' } }]
    })
    expect(changed.mock.calls).toEqual([
      [{ sentinel: { newValue: 'canonical' } }],
      [{ sentinel: { oldValue: 'canonical', newValue: 'other-frame' } }]
    ])
  })

  it('leaves opaque sandbox frames and native non-isolated contexts outside the bridge', async () => {
    for (const frame of [loadFrame(true, true), loadFrame(false)]) {
      expect(await frame.chrome.storage.session.get()).toEqual({ sentinel: 'native-only' })
      expect(frame.invoke).not.toHaveBeenCalled()
    }
  })

  it('keeps native document probes free of script-prefix injection through the actual installer order', async () => {
    const { chrome, nativeScript, nativeMessage } = loadFrame()
    await expect(
      chrome.tabs.sendMessage(1, 'message', { documentId: 'orca-document' })
    ).resolves.toBe('received')
    expect(nativeScript.mock.calls).toHaveLength(1)
    expect(nativeScript.mock.calls[0][0]).toEqual({
      target: { tabId: 1, frameIds: [0] },
      func: expect.any(Function)
    })
    expect(nativeMessage).toHaveBeenCalledWith(1, 'message', { documentId: 'native-document' })
  })
})
