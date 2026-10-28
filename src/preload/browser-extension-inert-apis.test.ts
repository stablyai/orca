import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  installBrowserExtensionInertApis,
  type BrowserExtensionInertApiContext
} from './browser-extension-inert-apis'

type Api = Record<string, unknown>

function isRecord(value: unknown): value is Api {
  return value !== null && typeof value === 'object'
}

function member(root: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), root)
}

function call(root: unknown, path: string, ...args: unknown[]): unknown {
  const fn = member(root, path)
  if (typeof fn !== 'function') {
    throw new Error(`${path} is not a function`)
  }
  return fn.call(member(root, path.split('.').slice(0, -1).join('.')), ...args)
}

/** Runs the installer from its source text, as contextBridge.executeInMainWorld does. */
function install(
  context: BrowserExtensionInertApiContext,
  manifest: Record<string, unknown> = {},
  chrome: Api = {}
): { chrome: Api; browser: Api } {
  const nativeManagedGet = vi.fn()
  const realm = {
    chrome: {
      runtime: { getManifest: () => manifest },
      storage: { managed: { get: nativeManagedGet, onChanged: { native: true } } },
      ...chrome
    },
    browser: {}
  }
  runInNewContext(`(${installBrowserExtensionInertApis.toString()})(context)`, {
    globalThis: realm,
    Promise,
    context
  })
  return realm
}

describe('installBrowserExtensionInertApis', () => {
  it('answers storage.managed like Chrome without a policy, by promise and callback', async () => {
    for (const context of ['page', 'worker', 'content-script'] as const) {
      const { chrome } = install(context)
      await expect(
        call(chrome, 'storage.managed.get', 'GrammarlyEnrollmentToken')
      ).resolves.toEqual({})
      await expect(call(chrome, 'storage.managed.getBytesInUse', null)).resolves.toBe(0)
      const viaCallback = await new Promise((resolve) =>
        call(chrome, 'storage.managed.get', null, resolve)
      )
      expect(viaCallback).toEqual({})
      expect(member(chrome, 'storage.managed.onChanged')).toEqual({ native: true })
    }
  })

  it('leaves storage alone when the extension has no storage permission', () => {
    const realm = { chrome: { runtime: { getManifest: () => ({}) } } }
    runInNewContext(`(${installBrowserExtensionInertApis.toString()})('page')`, {
      globalThis: realm,
      Promise
    })
    expect(member(realm.chrome, 'storage')).toBeUndefined()
  })

  it('gives content scripts chrome.extension.inIncognitoContext and dom.openOrClosedShadowRoot', () => {
    const { chrome } = install('content-script')
    expect(member(chrome, 'extension.inIncognitoContext')).toBe(false)
    const shadowRoot = { mode: 'open' }
    expect(call(chrome, 'dom.openOrClosedShadowRoot', { shadowRoot })).toBe(shadowRoot)
    expect(call(chrome, 'dom.openOrClosedShadowRoot', { shadowRoot: null })).toBeNull()
    expect(member(chrome, 'extension.getViews')).toBeUndefined()
    expect(member(chrome, 'runtime.onPerformanceWarning')).toBeUndefined()
  })

  it('adds getViews to pages only, and inert worker and page APIs on chrome and browser', async () => {
    const page = install('page', {}, { extension: { getBackgroundPage: () => null } })
    expect(call(page.chrome, 'extension.getViews', { type: 'popup' })).toEqual([])
    expect(typeof member(page.chrome, 'extension.getBackgroundPage')).toBe('function')

    const { chrome, browser } = install('worker', {}, { permissions: {} })
    expect(member(chrome, 'extension.getViews')).toBeUndefined()
    expect(member(chrome, 'dom')).toBeUndefined()
    for (const api of [chrome, browser]) {
      const onWarning = member(api, 'runtime.onPerformanceWarning')
      const listener = vi.fn()
      call(api, 'runtime.onPerformanceWarning.addListener', listener)
      expect(call(api, 'runtime.onPerformanceWarning.hasListener', listener)).toBe(true)
      expect(onWarning).toBe(member(chrome, 'runtime.onPerformanceWarning'))
      await expect(call(api, 'permissions.addHostAccessRequest', { tabId: 1 })).resolves.toBe(
        undefined
      )
      await expect(call(api, 'permissions.removeHostAccessRequest', { tabId: 1 })).resolves.toBe(
        undefined
      )
    }
  })

  it('installs omnibox for a manifest omnibox key and fontSettings for its permission', async () => {
    const without = install('worker')
    expect(without.chrome.omnibox).toBeUndefined()
    expect(without.chrome.fontSettings).toBeUndefined()

    const { chrome } = install('page', {
      omnibox: { keyword: 'lp' },
      permissions: ['fontSettings']
    })
    expect(typeof member(chrome, 'omnibox.onInputEntered.addListener')).toBe('function')
    expect(member(chrome, 'omnibox.OnInputEnteredDisposition.NEW_FOREGROUND_TAB')).toBe(
      'newForegroundTab'
    )
    const suggested = await new Promise((resolve) =>
      call(chrome, 'omnibox.setDefaultSuggestion', { description: 'Search' }, () =>
        resolve('called')
      )
    )
    expect(suggested).toBe('called')
    const fonts = await new Promise((resolve) => call(chrome, 'fontSettings.getFontList', resolve))
    expect(fonts).toContainEqual({ fontId: 'sans-serif', displayName: 'sans-serif' })
    await expect(
      call(chrome, 'fontSettings.getFont', { genericFamily: 'standard' })
    ).resolves.toEqual({ fontId: '', levelOfControl: 'not_controllable' })
    await expect(
      call(chrome, 'fontSettings.setFont', { genericFamily: 'standard', fontId: 'serif' })
    ).resolves.toBeUndefined()
  })

  it('keeps members Electron already provides', () => {
    const native = vi.fn()
    const { chrome } = install('page', {}, { extension: { getViews: native } })
    expect(member(chrome, 'extension.getViews')).toBe(native)
  })
})
