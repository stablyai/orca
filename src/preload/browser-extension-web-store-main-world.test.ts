import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_EXTENSION_WEB_STORE_CHANNEL,
  BROWSER_EXTENSION_WEB_STORE_EVENT_CHANNEL,
  CHROME_WEB_STORE_ORIGIN
} from '../shared/browser-extension-webstore'
import {
  CHROME_WEB_STORE_ORIGIN as PRELOAD_ORIGIN,
  PRELOAD_WEB_STORE_CHANNEL,
  PRELOAD_WEB_STORE_EVENT_CHANNEL
} from './browser-extension-web-store-bridge'
import {
  installChromeWebStoreApis,
  type ChromeWebStoreBridgeReply
} from './browser-extension-web-store-main-world'

type Callable = (...args: unknown[]) => unknown

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function member(root: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), root)
}

function isCallable(value: unknown): value is Callable {
  return typeof value === 'function'
}

function fn(root: unknown, path: string): Callable {
  const value = member(root, path)
  if (!isCallable(value)) {
    throw new Error(`${path} is not a function`)
  }
  return value
}

/** Runs the installer from its source text in a fresh realm, as executeInMainWorld does. */
function installInFreshRealm(
  reply: (method: string, args: unknown[]) => ChromeWebStoreBridgeReply,
  realmChrome?: Record<string, unknown>
) {
  let dispatch: ((event: string, args: unknown[]) => void) | null = null
  const calls: [string, unknown[]][] = []
  const realm: Record<string, unknown> = { console }
  if (realmChrome) {
    realm.chrome = realmChrome
  }
  const bridge = {
    call: async (method: string, args: unknown[]) => {
      calls.push([method, args])
      return reply(method, args)
    },
    onEvent: (handler: typeof dispatch) => {
      dispatch = handler
    }
  }
  runInNewContext(`(${installChromeWebStoreApis.toString()})(bridge, '146.0.7680.0')`, {
    ...realm,
    globalThis: realm,
    bridge
  })
  return { realm, calls, emit: (event: string, args: unknown[]) => dispatch?.(event, args) }
}

function lastErrors(realm: unknown): [unknown, unknown] {
  return [member(realm, 'chrome.runtime.lastError'), member(realm, 'chrome.extension.lastError')]
}

describe('installChromeWebStoreApis', () => {
  it('creates chrome, runtime, extension and management when the page has none', () => {
    const { realm } = installInFreshRealm(() => ({}))
    expect(typeof member(realm, 'chrome.webstorePrivate.beginInstallWithManifest3')).toBe(
      'function'
    )
    expect(typeof member(realm, 'chrome.management.getAll')).toBe('function')
    expect(isRecord(member(realm, 'chrome.runtime'))).toBe(true)
    expect(isRecord(member(realm, 'chrome.extension'))).toBe(true)
  })

  it('keeps existing runtime members', () => {
    const sendMessage = () => {}
    const { realm } = installInFreshRealm(() => ({}), { runtime: { sendMessage } })
    expect(member(realm, 'chrome.runtime.sendMessage')).toBe(sendMessage)
  })

  it('sets lastError on runtime and extension only while the callback runs', async () => {
    const { realm, calls } = installInFreshRealm(() => ({
      value: 'user_cancelled',
      error: 'User cancelled install'
    }))
    const seen: unknown[] = []
    fn(realm, 'chrome.webstorePrivate.beginInstallWithManifest3')(
      { id: 'x' },
      (result: unknown) => {
        seen.push(result, ...lastErrors(realm))
      }
    )
    await vi.waitFor(() => expect(seen).toHaveLength(3))

    expect(calls).toEqual([['beginInstallWithManifest3', [{ id: 'x' }]]])
    expect(seen).toEqual([
      'user_cancelled',
      { message: 'User cancelled install' },
      { message: 'User cancelled install' }
    ])
    expect(lastErrors(realm)).toEqual([undefined, undefined])
  })

  it('calls back with no arguments and no lastError on success', async () => {
    const { realm } = installInFreshRealm(() => ({}))
    const callback = vi.fn((...args: unknown[]) => args.concat(lastErrors(realm)))
    fn(realm, 'chrome.webstorePrivate.completeInstall')('id', callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(callback.mock.results[0].value).toEqual([undefined, undefined])
  })

  it('strips the callback, keeps optional arguments, and supports promises', async () => {
    const { realm, calls } = installInFreshRealm((method) =>
      method === 'management.getAll' ? { value: [{ id: 'a' }] } : { value: 'installable' }
    )
    const status = vi.fn()
    fn(realm, 'chrome.webstorePrivate.getExtensionStatus')('id', status)
    await expect(fn(realm, 'chrome.management.getAll')()).resolves.toEqual([{ id: 'a' }])
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('installable'))
    expect(calls).toEqual([
      ['getExtensionStatus', ['id']],
      ['management.getAll', []]
    ])
  })

  it('rejects the promise form with the error', async () => {
    const { realm } = installInFreshRealm(() => ({
      error: 'Extension x uninstall canceled by user.'
    }))
    await expect(
      fn(realm, 'chrome.management.uninstall')('x', { showConfirmDialog: true })
    ).rejects.toThrow('uninstall canceled by user')
  })

  it('answers the store stubs locally with the real Chrome version', async () => {
    const { realm, calls } = installInFreshRealm(() => ({}))
    await expect(fn(realm, 'chrome.webstorePrivate.getFullChromeVersion')()).resolves.toEqual({
      version_number: '146.0.7680.0'
    })
    await expect(fn(realm, 'chrome.webstorePrivate.isInIncognitoMode')()).resolves.toBe(false)
    await expect(fn(realm, 'chrome.webstorePrivate.getMV2DeprecationStatus')()).resolves.toBe(
      'hard_disable'
    )
    await expect(fn(realm, 'chrome.webstorePrivate.getBrowserLogin')()).resolves.toEqual({
      login: ''
    })
    expect(calls).toEqual([])
  })

  it('delivers management events to registered listeners', () => {
    const { realm, emit } = installInFreshRealm(() => ({}))
    const listener = vi.fn()
    fn(realm, 'chrome.management.onInstalled.addListener')(listener)
    emit('onInstalled', [{ id: 'a' }])
    emit('onUninstalled', ['a'])
    fn(realm, 'chrome.management.onInstalled.removeListener')(listener)
    emit('onInstalled', [{ id: 'b' }])
    expect(listener.mock.calls).toEqual([[{ id: 'a' }]])
  })
})

describe('store bridge constants', () => {
  it('match the shared copies main uses', () => {
    expect(PRELOAD_ORIGIN).toBe(CHROME_WEB_STORE_ORIGIN)
    expect(PRELOAD_WEB_STORE_CHANNEL).toBe(BROWSER_EXTENSION_WEB_STORE_CHANNEL)
    expect(PRELOAD_WEB_STORE_EVENT_CHANNEL).toBe(BROWSER_EXTENSION_WEB_STORE_EVENT_CHANNEL)
  })
})
