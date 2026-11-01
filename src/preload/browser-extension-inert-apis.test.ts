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

  it('keeps members Electron already provides', () => {
    const native = vi.fn()
    const { chrome } = install('page', {}, { extension: { getViews: native } })
    expect(member(chrome, 'extension.getViews')).toBe(native)
  })
})
