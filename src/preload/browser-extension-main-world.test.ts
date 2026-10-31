import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_EXTENSION_API_SURFACE } from './browser-extension-api-surface'
import { passesBrowserExtensionEventFilter } from './browser-extension-event-filters'
import {
  installBrowserExtensionApis,
  type BrowserExtensionInvokeReply
} from './browser-extension-main-world'

type Api = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

function member(root: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), root)
}

function call(root: unknown, path: string, ...args: unknown[]): unknown {
  const fn = member(root, path)
  if (!isCallable(fn)) {
    throw new Error(`${path} is not a function`)
  }
  return fn.call(member(root, path.split('.').slice(0, -1).join('.')), ...args)
}

/**
 * Runs the installer the way contextBridge.executeInMainWorld does: from its source text, in a
 * realm that shares nothing with this module.
 */
class FakeImageData {
  readonly data: Uint8ClampedArray
  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.data = new Uint8ClampedArray(width * height * 4).fill(7)
  }
}

function installInFreshRealm(
  permissions: string[],
  replies: (namespace: string, method: string, args: unknown[]) => BrowserExtensionInvokeReply,
  manifestKeys: Record<string, unknown> = {}
) {
  let dispatch: ((namespace: string, event: string, args: unknown[]) => void) | null = null
  const calls: unknown[][] = []
  const listens: unknown[][] = []
  const nativeQuery = vi.fn((_info: unknown, callback: (tabs: unknown[]) => void) =>
    callback([{ id: 5, url: 'https://example.com/', title: 'Example' }])
  )
  const nativeOnInstalled = { addListener: vi.fn() }
  const realm: {
    chrome: Api
    browser: Api
    console: Console
    URL: typeof URL
    ImageData: typeof FakeImageData
  } = {
    chrome: {
      runtime: {
        getManifest: () => ({ permissions, ...manifestKeys }),
        onInstalled: nativeOnInstalled
      },
      tabs: { query: nativeQuery, sendMessage: () => {} }
    },
    browser: { runtime: { onInstalled: nativeOnInstalled }, tabs: {} },
    console,
    URL,
    ImageData: FakeImageData
  }
  const bridge = {
    call: async (namespace: string, method: string, args: unknown[]) => {
      calls.push([namespace, method, args])
      return replies(namespace, method, args)
    },
    listen: (namespace: string, event: string, active: boolean, filters?: unknown[]) =>
      listens.push(filters ? [namespace, event, active, filters] : [namespace, event, active]),
    onEvent: (handler: typeof dispatch) => {
      dispatch = handler
    },
    passesFilter: passesBrowserExtensionEventFilter
  }
  runInNewContext(`(${installBrowserExtensionApis.toString()})(bridge, surface)`, {
    ...realm,
    globalThis: realm,
    bridge,
    surface: BROWSER_EXTENSION_API_SURFACE
  })
  return {
    chrome: realm.chrome,
    browser: realm.browser,
    calls,
    listens,
    nativeQuery,
    nativeOnInstalled,
    emit: (ns: string, ev: string, args: unknown[]) => dispatch?.(ns, ev, args)
  }
}

const ok = (value: unknown): BrowserExtensionInvokeReply => ({ ok: true, value })

describe('installBrowserExtensionApis', () => {
  it('adds missing namespaces on chrome and mirrors them to browser', () => {
    const { chrome, browser } = installInFreshRealm(['webNavigation'], () => ok(null))
    for (const api of [chrome, browser]) {
      expect(typeof member(api, 'windows.create')).toBe('function')
      expect(typeof member(api, 'tabs.create')).toBe('function')
      expect(typeof member(api, 'webNavigation.getAllFrames')).toBe('function')
      expect(member(api, 'windows.WINDOW_ID_CURRENT')).toBe(-2)
    }
    expect(typeof member(chrome, 'tabs.sendMessage')).toBe('function')
  })

  it('leaves out namespaces whose permission the manifest lacks', () => {
    const { chrome } = installInFreshRealm([], () => ok(null))
    expect(chrome.webNavigation).toBeUndefined()
  })

  it('installs chrome.action only for a manifest with an action, and browserAction for MV2', () => {
    expect(installInFreshRealm([], () => ok(null)).chrome.action).toBeUndefined()
    const mv3 = installInFreshRealm([], () => ok(null), { action: {} })
    expect(typeof member(mv3.chrome, 'action.setBadgeText')).toBe('function')
    expect(mv3.chrome.browserAction).toBeUndefined()
    const mv2 = installInFreshRealm([], () => ok(null), { browser_action: {} })
    expect(typeof member(mv2.chrome, 'browserAction.onClicked.addListener')).toBe('function')
  })

  it('flattens ImageData so its pixels survive the bridge', async () => {
    const { chrome, calls } = installInFreshRealm([], () => ok(undefined), { action: {} })
    await call(chrome, 'action.setIcon', { imageData: { 16: new FakeImageData(1, 1) }, tabId: 3 })
    expect(calls.at(-1)).toEqual([
      'action',
      'setIcon',
      [{ imageData: { 16: { width: 1, height: 1, data: [7, 7, 7, 7] } }, tabId: 3 }]
    ])
  })

  it('drops trailing undefined arguments, as Chrome does, before finding the callback', async () => {
    const { chrome, calls } = installInFreshRealm([], () => ok(undefined), { action: {} })
    await call(chrome, 'action.setIcon', { path: 'icon.png' }, undefined)
    const called = await new Promise((resolve) =>
      call(chrome, 'action.setTitle', { title: 'T' }, () => resolve(true), undefined)
    )
    expect(called).toBe(true)
    expect(calls).toEqual([
      ['action', 'setIcon', [{ path: 'icon.png' }]],
      ['action', 'setTitle', [{ title: 'T' }]]
    ])
  })

  it('answers promise and callback calls, and sets lastError only during a failed callback', async () => {
    const { chrome } = installInFreshRealm([], (_ns, method) =>
      method === 'get' ? { ok: false, error: 'No window with id: 9.' } : ok({ id: 1 })
    )
    await expect(call(chrome, 'windows.getCurrent')).resolves.toEqual({ id: 1 })

    const fromCallback = await new Promise((resolve) => call(chrome, 'windows.getCurrent', resolve))
    expect(fromCallback).toEqual({ id: 1 })

    const lastError = await new Promise((resolve) =>
      call(chrome, 'windows.get', 9, () => resolve(member(chrome, 'runtime.lastError.message')))
    )
    expect(lastError).toBe('No window with id: 9.')
    expect(member(chrome, 'runtime.lastError')).toBeUndefined()
    await expect(call(chrome, 'windows.get', 9)).rejects.toThrow('No window with id: 9.')
  })

  it('runs the native query without Orca-owned keys and sends its result to main', async () => {
    const { chrome, calls, nativeQuery } = installInFreshRealm([], () => ok([]))
    await call(chrome, 'tabs.query', { active: true, currentWindow: true, url: 'https://*/*' })
    expect(nativeQuery.mock.calls[0][0]).toEqual({ url: 'https://*/*' })
    expect(calls.at(-1)).toEqual([
      'tabs',
      'query',
      [
        { active: true, currentWindow: true, url: 'https://*/*' },
        [{ id: 5, url: 'https://example.com/', title: 'Example' }]
      ]
    ])
  })

  it('tells main when the first listener arrives and the last leaves, and applies url filters', () => {
    const { chrome, listens, emit } = installInFreshRealm(['webNavigation'], () => ok(null))
    const all = vi.fn()
    const filtered = vi.fn()
    const onCommitted = 'webNavigation.onCommitted'
    call(chrome, `${onCommitted}.addListener`, all)
    call(chrome, `${onCommitted}.addListener`, filtered, { url: [{ hostSuffix: 'example.com' }] })
    emit('webNavigation', 'onCommitted', [{ url: 'https://other.test/' }])
    emit('webNavigation', 'onCommitted', [{ url: 'https://app.example.com/' }])
    call(chrome, `${onCommitted}.removeListener`, all)
    call(chrome, `${onCommitted}.removeListener`, filtered)

    expect(all).toHaveBeenCalledTimes(2)
    expect(filtered).toHaveBeenCalledTimes(1)
    expect(listens).toEqual([
      ['webNavigation', 'onCommitted', true],
      ['webNavigation', 'onCommitted', false]
    ])
  })

  it('replaces the native runtime.onInstalled on chrome and browser so only Orca fires it', () => {
    const { chrome, browser, listens, emit, nativeOnInstalled } = installInFreshRealm([], () =>
      ok(null)
    )
    const onInstalled = vi.fn()
    call(chrome, 'runtime.onInstalled.addListener', onInstalled)
    emit('runtime', 'onInstalled', [{ reason: 'install' }])

    expect(member(browser, 'runtime.onInstalled')).toBe(member(chrome, 'runtime.onInstalled'))
    expect(typeof member(chrome, 'runtime.onStartup.addListener')).toBe('function')
    expect(nativeOnInstalled.addListener).not.toHaveBeenCalled()
    expect(onInstalled).toHaveBeenCalledWith({ reason: 'install' })
    expect(listens).toEqual([['runtime', 'onInstalled', true]])
  })
})

describe('Wave 2 API shapes', () => {
  it('returns a contextMenus.create id synchronously and sends it to main', async () => {
    const { chrome, calls } = installInFreshRealm(['contextMenus'], () => ok('fill'))
    expect(
      call(chrome, 'contextMenus.create', { id: 'fill', title: 'Fill', onclick: () => {} })
    ).toBe('fill')
    const generated = call(chrome, 'contextMenus.create', { title: 'No id' }, () => {})
    expect(typeof generated).toBe('number')
    await Promise.resolve()
    expect(calls).toEqual([
      ['contextMenus', 'create', [{ id: 'fill', title: 'Fill' }]],
      ['contextMenus', 'create', [{ id: generated, title: 'No id' }]]
    ])
  })

  it('builds chrome.privacy setting objects, installed for an optional permission too', async () => {
    const { chrome, calls } = installInFreshRealm([], () => ok({ value: true }), {
      optional_permissions: ['privacy']
    })
    await expect(call(chrome, 'privacy.services.passwordSavingEnabled.get', {})).resolves.toEqual({
      value: true
    })
    expect(calls.at(-1)).toEqual(['privacy', 'services.passwordSavingEnabled.get', [{}]])
    expect(
      typeof member(chrome, 'privacy.services.passwordSavingEnabled.onChange.addListener')
    ).toBe('function')
  })

  it('sends webRequest listener filters to main and filters each listener on delivery', () => {
    const { chrome, listens, emit } = installInFreshRealm(['webRequest'], () => ok(undefined))
    const pages: unknown[] = []
    const images: unknown[] = []
    const pageFilter = { urls: ['https://*.bank.test/*'], types: ['main_frame'] }
    call(
      chrome,
      'webRequest.onCompleted.addListener',
      (details: unknown) => pages.push(details),
      pageFilter
    )
    call(chrome, 'webRequest.onCompleted.addListener', (details: unknown) => images.push(details), {
      urls: ['<all_urls>'],
      types: ['image']
    })
    expect(listens.at(-1)).toEqual([
      'webRequest',
      'onCompleted',
      true,
      [pageFilter, { urls: ['<all_urls>'], types: ['image'] }]
    ])
    emit('webRequest', 'onCompleted', [{ url: 'https://www.bank.test/login', type: 'main_frame' }])
    emit('webRequest', 'onCompleted', [{ url: 'https://www.bank.test/logo.png', type: 'image' }])
    emit('webRequest', 'onCompleted', [{ url: 'https://evil.test/', type: 'main_frame' }])
    expect(pages).toEqual([{ url: 'https://www.bank.test/login', type: 'main_frame' }])
    expect(images).toEqual([{ url: 'https://www.bank.test/logo.png', type: 'image' }])
  })
})
