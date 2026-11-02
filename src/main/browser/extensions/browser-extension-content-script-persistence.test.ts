import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentScriptMethod } from './browser-extension-content-scripts'

type Script = Record<string, unknown> & { id: string }
const mocks = vi.hoisted(() => ({
  directory: '',
  scripts: new Map<string, Script>(),
  beforeExecute: async (): Promise<void> => {},
  beforeCallback: async (): Promise<void> => {},
  nativeError: '',
  windows: new Array<{ options: unknown; destroyed: boolean }>()
}))
vi.mock('electron', () => ({
  app: { on() {} },
  webFrameMain: { fromId() {} },
  BrowserWindow: class {
    record: { options: unknown; destroyed: boolean }
    constructor(options: unknown) {
      this.record = { options, destroyed: false }
      mocks.windows.push(this.record)
    }
    async loadURL() {}
    webContents = {
      executeJavaScript: async (code: string) => {
        await mocks.beforeExecute()
        const runtime: { lastError?: { message: string } } = {}
        const complete = async (callback: (value?: unknown) => void, value?: unknown) => {
          await mocks.beforeCallback()
          if (mocks.nativeError) {
            runtime.lastError = { message: mocks.nativeError }
          }
          callback(value)
          delete runtime.lastError
        }
        return runInNewContext(code, {
          chrome: {
            runtime,
            scripting: {
              registerContentScripts(scripts: Script[], callback: () => void) {
                if (!mocks.nativeError) {
                  for (const script of scripts) {
                    if (mocks.scripts.has(script.id)) {
                      runtime.lastError = { message: 'Duplicate script ID' }
                      callback()
                      delete runtime.lastError
                      return
                    }
                    mocks.scripts.set(script.id, { ...script })
                  }
                }
                complete(callback)
              },
              updateContentScripts(updates: Script[], callback: () => void) {
                if (!mocks.nativeError) {
                  for (const update of updates) {
                    mocks.scripts.set(update.id, { ...mocks.scripts.get(update.id), ...update })
                  }
                }
                complete(callback)
              },
              unregisterContentScripts(filter: { ids?: string[] }, callback: () => void) {
                for (const id of filter.ids ?? [...mocks.scripts.keys()]) {
                  mocks.scripts.delete(id)
                }
                complete(callback)
              },
              getRegisteredContentScripts(
                filterOrCallback: { ids?: string[] } | ((value: Script[]) => void),
                callback?: (value: Script[]) => void
              ) {
                const filter = typeof filterOrCallback === 'function' ? {} : filterOrCallback
                const done = typeof filterOrCallback === 'function' ? filterOrCallback : callback
                done?.(
                  [...mocks.scripts.values()]
                    .filter((script) => !filter.ids || filter.ids.includes(script.id))
                    .map((script) => ({ ...script }))
                )
              }
            }
          }
        })
      }
    }
    destroy() {
      this.record.destroyed = true
    }
  }
}))
vi.mock('./browser-extension-profile-data-directory', () => ({
  getBrowserExtensionProfileDataDirectory: () => mocks.directory
}))
mocks.directory = mkdtempSync(join(tmpdir(), 'orca-content-script-persistence-'))

const registry = await import('./browser-extension-namespace-registry')
const { registerScriptingNamespaces } = await import('./api/scripting')
const { forgetBrowserExtensionContentScriptRestore, restoreBrowserExtensionContentScripts } =
  await import('./browser-extension-content-scripts')
const { getBrowserExtensionProfileStateStore } =
  await import('./browser-extension-profile-state-store')
const { installBrowserExtensionApis } =
  await import('../../../preload/browser-extension-main-world')
const { BROWSER_EXTENSION_API_SURFACE } =
  await import('../../../preload/browser-extension-api-surface')
const extension: Electron.Extension = {
  id: 'a'.repeat(32),
  name: 'Popup only',
  version: '1',
  path: '/example',
  url: '',
  manifest: {
    manifest_version: 3,
    permissions: ['scripting'],
    action: { default_popup: 'popup.html' }
  }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native page creation is mocked; the owner only uses session identity.
const session = {} as Electron.Session
const store = getBrowserExtensionProfileStateStore()
const stored = () => store.read('default', extension.id).contentScripts
function context(fromWorker: boolean) {
  const scripting: Partial<Record<ContentScriptMethod, unknown>> = {}
  const chrome = { runtime: { getManifest: () => extension.manifest }, scripting }
  const bridge = {
    call: async (namespace: string, method: string, args: unknown[]) => ({
      ok: true,
      value: await registry
        .getBrowserExtensionNamespace(namespace)
        ?.methods[method].invoke(
          { extension, session, browserProfileId: 'default', fromWorker },
          args
        )
    }),
    listen() {},
    onEvent() {},
    passesFilter: () => true
  }
  runInNewContext(`(${installBrowserExtensionApis.toString()})(bridge, surface)`, {
    chrome,
    bridge,
    console,
    surface: { scripting: BROWSER_EXTENSION_API_SURFACE.scripting }
  })
  const call = async (method: ContentScriptMethod, ...args: unknown[]) => {
    const fn = chrome.scripting[method]
    if (typeof fn !== 'function') {
      throw new Error('Missing scripting method')
    }
    return fn(...args)
  }
  return call
}
registerScriptingNamespaces()
beforeEach(() => {
  forgetBrowserExtensionContentScriptRestore(session, extension.id)
  mocks.scripts.clear()
  mocks.windows.length = 0
  mocks.beforeExecute = async () => {}
  mocks.beforeCallback = async () => {}
  mocks.nativeError = ''
  store.update('default', extension.id, (state) => ({ ...state, contentScripts: [] }))
})

describe('native content script ownership', () => {
  it('serializes worker and page mutations through native readback and persistence', async () => {
    const worker = context(true),
      page = context(false)
    await worker('registerContentScripts', [{ id: 'x', matches: ['https://*/*'], js: ['old.js'] }])
    let release = () => {}
    let started = () => {}
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.beforeExecute = async () => {
      started()
      await pending
    }
    const first = worker('updateContentScripts', [{ id: 'x', js: ['first.js'] }])
    await entered
    const second = page('updateContentScripts', [
      { id: 'x', js: ['last.js'], persistAcrossSessions: false }
    ])
    release()
    await Promise.all([first, second])
    expect([...mocks.scripts.values()]).toEqual([
      { id: 'x', matches: ['https://*/*'], js: ['last.js'], persistAcrossSessions: false }
    ])
    expect(stored()).toEqual([])
    await page('updateContentScripts', [{ id: 'x', persistAcrossSessions: true }])
    expect(stored()).toEqual([...mocks.scripts.values()])
    await worker('unregisterContentScripts', { ids: ['x'] })
    expect(stored()).toEqual([])
    expect(await page('getRegisteredContentScripts')).toEqual([])
    expect(mocks.windows.every((window) => window.destroyed)).toBe(true)
  })

  it('restores popup-only registrations at startup before queued API mutations', async () => {
    const script = { id: 'saved', matches: ['https://*/*'], js: ['saved.js'] }
    store.update('default', extension.id, (state) => ({ ...state, contentScripts: [script] }))
    const restoring = restoreBrowserExtensionContentScripts(session, 'default', extension, 2_500)
    const updating = context(false)('updateContentScripts', [{ id: 'saved', allFrames: true }])
    await Promise.all([restoring, updating])
    expect(stored()).toEqual([{ ...script, allFrames: true }])
    expect([...mocks.scripts.values()]).toEqual(stored())
    expect(mocks.windows[0].options).toMatchObject({
      show: false,
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
  })

  it('propagates a native error without persisting the failed mutation or blocking the next one', async () => {
    const call = context(true)
    mocks.nativeError = 'Permission denied'
    await expect(call('registerContentScripts', [{ id: 'bad' }])).rejects.toThrow(
      'Permission denied'
    )
    expect(stored()).toEqual([])
    mocks.nativeError = ''
    await call('registerContentScripts', [{ id: 'good', js: ['good.js'] }])
    expect(stored()).toEqual([{ id: 'good', js: ['good.js'] }])
  })

  it('retires timed-out native work instead of allowing a successor to overlap it', async () => {
    const script = { id: 'saved', js: ['saved.js'] }
    store.update('default', extension.id, (state) => ({ ...state, contentScripts: [script] }))
    let release = () => {}
    let completed = () => {}
    const nativeCompleted = new Promise<void>((resolve) => {
      completed = resolve
    })
    mocks.beforeCallback = () =>
      new Promise<void>((resolve) => {
        release = () => {
          resolve()
          completed()
        }
      })
    await expect(
      restoreBrowserExtensionContentScripts(session, 'default', extension, 1)
    ).rejects.toThrow('timed out')
    await expect(context(false)('unregisterContentScripts', {})).rejects.toThrow('timed out')
    expect(mocks.windows).toHaveLength(1)
    expect(mocks.windows[0].destroyed).toBe(true)
    expect([...mocks.scripts.values()]).toEqual([script])
    release()
    await nativeCompleted
    expect(stored()).toEqual([script])
  })
})
