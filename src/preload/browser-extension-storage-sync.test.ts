import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionInvokeReply } from './browser-extension-main-world'
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
  it('drops trailing undefined arguments before finding the callback, as Chrome does', async () => {
    const page = install(() => ({ ok: true, value: {} }))
    await call(page.chrome, 'storage.sync.get', 'theme', undefined)
    await new Promise((resolve) => call(page.chrome, 'storage.sync.get', null, resolve, undefined))
    expect(page.calls).toEqual([
      [PRELOAD_STORAGE_SYNC_NAMESPACE, 'get', ['theme']],
      [PRELOAD_STORAGE_SYNC_NAMESPACE, 'get', [null]]
    ])
  })

  it('replaces the disabled native area with calls to main, as promises or callbacks', async () => {
    const page = install((method) =>
      method === 'get' ? { ok: true, value: { theme: 'dark' } } : { ok: true, value: undefined }
    )
    expect(page.chrome.storage.sync).not.toBe(page.nativeSync)
    expect(page.chrome.storage.sync).toMatchObject({ QUOTA_BYTES: 102_400, MAX_ITEMS: 512 })

    await expect(call(page.chrome, 'storage.sync.get', 'theme')).resolves.toEqual({
      theme: 'dark'
    })
    const got = await new Promise((resolve) => call(page.chrome, 'storage.sync.get', resolve))
    expect(got).toEqual({ theme: 'dark' })
    const setDone = vi.fn()
    expect(
      call(page.chrome, 'storage.sync.set', { at: new Date(0), skip: undefined }, setDone)
    ).toBeUndefined()
    await vi.waitFor(() => expect(setDone).toHaveBeenCalledWith())
    await expect(
      call(page.chrome, 'storage.sync.setAccessLevel', {
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
      })
    ).resolves.toBeUndefined()
    await expect(
      call(page.chrome, 'storage.sync.setAccessLevel', { accessLevel: 'TRUSTED_CONTEXTS' })
    ).rejects.toThrow('This StorageArea is not available for setting access level')

    expect(page.calls).toEqual([
      [PRELOAD_STORAGE_SYNC_NAMESPACE, 'get', ['theme']],
      [PRELOAD_STORAGE_SYNC_NAMESPACE, 'get', []],
      [PRELOAD_STORAGE_SYNC_NAMESPACE, 'set', [{ at: '1970-01-01T00:00:00.000Z' }]]
    ])
    expect(page.nativeSync.get).not.toHaveBeenCalled()
    expect(page.nativeSync.set).not.toHaveBeenCalled()
  })

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

  it("delivers main's sync changes to sync.onChanged and storage.onChanged with 'sync'", async () => {
    const own = { mine: { newValue: 1 } }
    const page = install((method) => ({ ok: true, value: method === 'set' ? own : undefined }))
    const all: unknown[][] = []
    const area: unknown[][] = []
    const onAll = (changes: unknown, areaName: unknown) => all.push([areaName, changes])
    call(page.chrome, 'storage.onChanged.addListener', onAll)
    call(page.chrome, 'storage.sync.onChanged.addListener', (changes: unknown) =>
      area.push([changes])
    )
    // The underlying onChanged keeps its own listeners for local and session.
    expect(page.native.listeners.has(onAll)).toBe(true)
    expect(call(page.chrome, 'storage.onChanged.hasListener', onAll)).toBe(true)
    expect(page.listens).toEqual([[PRELOAD_STORAGE_SYNC_NAMESPACE, 'onChanged', true]])

    const changes = { theme: { oldValue: 'light', newValue: 'dark' } }
    page.emit(changes)
    expect(all).toEqual([['sync', changes]])
    expect(area).toEqual([[changes]])

    // Main skips the writer, which fires its own listeners from the changes main returns.
    await expect(call(page.chrome, 'storage.sync.set', { mine: 1 })).resolves.toBeUndefined()
    expect(all).toEqual([
      ['sync', changes],
      ['sync', own]
    ])
    expect(area).toEqual([[changes], [own]])

    call(page.chrome, 'storage.onChanged.removeListener', onAll)
    expect(page.native.listeners.has(onAll)).toBe(false)
    page.emit(changes)
    expect(all).toHaveLength(2)
    expect(area).toHaveLength(3)
  })

  it("makes a content script's relayed call and fires this context's listeners for its writes", async () => {
    const changes = { theme: { newValue: 'dark' } }
    const worker = install((method) => ({ ok: true, value: method === 'set' ? changes : 'value' }))
    const heard: unknown[] = []
    call(worker.chrome, 'storage.sync.onChanged.addListener', (change: unknown) =>
      heard.push(change)
    )

    await expect(worker.relay('get', ['theme'])).resolves.toEqual({ ok: true, value: 'value' })
    await expect(worker.relay('set', [{ theme: 'dark' }])).resolves.toEqual({
      ok: true,
      value: changes
    })
    expect(heard).toEqual([changes])
    await expect(worker.relay('setAccessLevel', [{}])).resolves.toMatchObject({ ok: false })
    expect(worker.calls).toEqual([
      [PRELOAD_STORAGE_SYNC_NAMESPACE, 'get', ['theme']],
      [PRELOAD_STORAGE_SYNC_NAMESPACE, 'set', [{ theme: 'dark' }]]
    ])
  })

  it('passes every sync change on to content scripts, naming the one that wrote it', async () => {
    const own = { mine: { newValue: 1 } }
    const forward = vi.fn()
    const worker = install(() => ({ ok: true, value: own }), forward)
    // Listens with no listener of its own: content scripts hear other contexts only this way.
    expect(worker.listens).toEqual([[PRELOAD_STORAGE_SYNC_NAMESPACE, 'onChanged', true]])

    const elsewhere = { theme: { newValue: 'dark' } }
    worker.emit(elsewhere)
    await call(worker.chrome, 'storage.sync.set', { mine: 1 })
    await worker.relay('set', [{ mine: 1 }], 'cs-1')
    expect(forward.mock.calls).toEqual([
      [elsewhere, undefined],
      [own, undefined],
      [own, 'cs-1']
    ])
  })
})
