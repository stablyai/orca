import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionInvokeReply } from '../api/browser-extension-main-world'
import {
  installBrowserExtensionStorageSync,
  PRELOAD_STORAGE_SYNC_CONSTANTS,
  PRELOAD_STORAGE_SYNC_NAMESPACE
} from './browser-extension-storage-sync'

type Runtime = { lastError?: { message: string } }

function nativeEvent() {
  const listeners = new Set<unknown>()
  return {
    listeners,
    addListener: vi.fn((callback: unknown) => listeners.add(callback)),
    removeListener: vi.fn((callback: unknown) => listeners.delete(callback))
  }
}

/** Runs the installer from its source text, as contextBridge.executeInMainWorld does. */
function install(
  reply: (method: string, args: unknown[]) => BrowserExtensionInvokeReply,
  forward?: (changes: unknown, from?: string) => void
) {
  const runtime: Runtime = {}
  const native = nativeEvent()
  const nativeSync = { get: vi.fn(), set: vi.fn() }
  const chrome = { runtime, storage: { local: {}, sync: nativeSync, onChanged: native } }
  let dispatch: ((namespace: string, event: string, args: unknown[]) => void) | null = null
  const calls: unknown[][] = []
  const listens: unknown[][] = []
  const bridge = {
    call: async (namespace: string, method: string, args: unknown[]) => {
      calls.push([namespace, method, args])
      return reply(method, args)
    },
    listen: (namespace: string, event: string, active: boolean) =>
      listens.push([namespace, event, active]),
    onEvent: (handler: typeof dispatch) => {
      dispatch = handler
    },
    passesFilter: () => true
  }
  const realm = { chrome, console, JSON, Promise }
  const relay: unknown = runInNewContext(
    `(${installBrowserExtensionStorageSync.toString()})(bridge, constants, forward)`,
    {
      ...realm,
      globalThis: realm,
      bridge,
      constants: PRELOAD_STORAGE_SYNC_CONSTANTS,
      forward
    }
  )
  return {
    relay: (method: string, args: unknown[], from?: string): unknown =>
      typeof relay === 'function' ? relay(method, args, from) : undefined,
    chrome,
    native,
    nativeSync,
    calls,
    listens,
    emit: (changes: unknown) => dispatch?.(PRELOAD_STORAGE_SYNC_NAMESPACE, 'onChanged', [changes])
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function call(root: unknown, path: string, ...args: unknown[]): unknown {
  const keys = path.split('.')
  const name = keys.pop() ?? ''
  const owner = keys.reduce<unknown>(
    (value, key) => (isRecord(value) ? value[key] : undefined),
    root
  )
  const fn = isRecord(owner) ? owner[name] : null
  if (typeof fn !== 'function') {
    throw new Error(`${path} is not a function`)
  }
  return fn.call(owner, ...args)
}

describe('installBrowserExtensionStorageSync', () => {
  it('sets lastError only inside a failed callback and rejects a failed promise', async () => {
    const page = install(() => ({ ok: false, error: 'QUOTA_BYTES quota exceeded' }))
    const lastError = await new Promise((resolve) =>
      call(page.chrome, 'storage.sync.set', { big: 1 }, () =>
        resolve(page.chrome.runtime.lastError?.message)
      )
    )
    expect(lastError).toBe('QUOTA_BYTES quota exceeded')
    expect(page.chrome.runtime.lastError).toBeUndefined()
    await expect(call(page.chrome, 'storage.sync.set', { big: 1 })).rejects.toThrow(
      'QUOTA_BYTES quota exceeded'
    )
  })
})
