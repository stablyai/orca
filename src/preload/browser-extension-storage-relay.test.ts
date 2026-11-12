import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionInvokeReply } from './browser-extension-main-world'
import {
  installBrowserExtensionStorageRelay,
  PRELOAD_STORAGE_RELAY_NAMESPACE,
  type BrowserExtensionStorageContext
} from './browser-extension-storage-relay'

type Callback = (value?: unknown) => void
type Runtime = { lastError?: { message: string } }

/**
 * Callback-style StorageArea like Electron's: each call takes effect in call order, replies are
 * async, and lastError is set only in the callback.
 */
function fakeArea(runtime: Runtime, initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial))
  let failNext: string | null = null
  const reply = (callback: Callback, value?: unknown) =>
    queueMicrotask(() => {
      const error = failNext
      failNext = null
      if (error) {
        runtime.lastError = { message: error }
      }
      try {
        callback(error ? undefined : value)
      } finally {
        delete runtime.lastError
      }
    })
  const read = (keys: unknown) =>
    Object.fromEntries(
      [...data].filter(([key]) => keys === null || (Array.isArray(keys) && keys.includes(key)))
    )
  return {
    data,
    failNextWrite: (message: string) => {
      failNext = message
    },
    area: {
      get: vi.fn((keys: unknown, callback: Callback) => {
        const value = structuredClone(read(keys))
        queueMicrotask(() => callback(value))
      }),
      set: vi.fn((items: unknown, callback: Callback) => {
        if (typeof items !== 'object' || items === null) {
          throw new TypeError('Error in invocation of storage.set')
        }
        if (!failNext) {
          for (const [key, value] of Object.entries(items)) {
            data.set(key, structuredClone(value))
          }
        }
        reply(callback)
      }),
      remove: vi.fn((keys: string | string[], callback: Callback) => {
        if (!failNext) {
          for (const key of [keys].flat()) {
            data.delete(key)
          }
        }
        reply(callback)
      }),
      clear: vi.fn((callback: Callback) => {
        if (!failNext) {
          data.clear()
        }
        reply(callback)
      }),
      onChanged: { native: true }
    }
  }
}

/** Runs the installer from its source text, as contextBridge.executeInMainWorld does. */
function install(context: BrowserExtensionStorageContext) {
  const runtime: Runtime = {}
  const local = fakeArea(runtime, { kept: 'same', changed: 'old', gone: 1 })
  const session = fakeArea(runtime)
  const chrome = {
    runtime,
    storage: { local: local.area, session: session.area, onChanged: { native: true } }
  }
  let dispatch: ((namespace: string, event: string, args: unknown[]) => void) | null = null
  const calls: unknown[][] = []
  const listens: unknown[][] = []
  const bridge = {
    call: async (namespace: string, method: string, args: unknown[]) => {
      calls.push([namespace, method, args])
      return { ok: true, value: undefined } satisfies BrowserExtensionInvokeReply
    },
    listen: (namespace: string, event: string, active: boolean) =>
      listens.push([namespace, event, active]),
    onEvent: (handler: typeof dispatch) => {
      dispatch = handler
    },
    passesFilter: () => true
  }
  const realm = { chrome, console, queueMicrotask }
  runInNewContext(`(${installBrowserExtensionStorageRelay.toString()})(bridge, context)`, {
    ...realm,
    globalThis: realm,
    bridge,
    context
  })
  const all: unknown[][] = []
  const perArea: unknown[][] = []
  return {
    chrome,
    local,
    session,
    calls,
    listens,
    all,
    perArea,
    hasEventHandler: () => dispatch !== null,
    emit: (args: unknown[]) => dispatch?.(PRELOAD_STORAGE_RELAY_NAMESPACE, 'onChanged', args),
    listen: () => {
      call(chrome, 'storage.onChanged.addListener', (changes: unknown, area: unknown) =>
        all.push([area, changes])
      )
      call(chrome, 'storage.local.onChanged.addListener', (changes: unknown) =>
        perArea.push(['local', changes])
      )
      call(chrome, 'storage.session.onChanged.addListener', (changes: unknown) =>
        perArea.push(['session', changes])
      )
    }
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('installBrowserExtensionStorageRelay in a worker', () => {
  it('fires onChanged and the area event once per write with only the keys that changed', async () => {
    const worker = install('worker')
    worker.listen()
    expect(worker.listens).toEqual([[PRELOAD_STORAGE_RELAY_NAMESPACE, 'onChanged', true]])

    await call(worker.chrome, 'storage.local.set', { kept: 'same', changed: 'new', added: [1] })
    await call(worker.chrome, 'storage.local.set', { kept: 'same' })
    await call(worker.chrome, 'storage.local.remove', ['gone', 'missing'])
    await call(worker.chrome, 'storage.session.set', { token: 'abc' })
    await call(worker.chrome, 'storage.session.clear')

    const written = { changed: { oldValue: 'old', newValue: 'new' }, added: { newValue: [1] } }
    expect(worker.all).toEqual([
      ['local', written],
      ['local', { gone: { oldValue: 1 } }],
      ['session', { token: { newValue: 'abc' } }],
      ['session', { token: { oldValue: 'abc' } }]
    ])
    expect(worker.perArea).toEqual([
      ['local', written],
      ['local', { gone: { oldValue: 1 } }],
      ['session', { token: { newValue: 'abc' } }],
      ['session', { token: { oldValue: 'abc' } }]
    ])
    expect(worker.calls).toEqual([])
  })

  it('reports old values in write order when writes are not awaited', async () => {
    const worker = install('worker')
    worker.listen()
    void call(worker.chrome, 'storage.local.set', { changed: 'first' })
    await call(worker.chrome, 'storage.local.set', { changed: 'second' })
    expect(worker.all).toEqual([
      ['local', { changed: { oldValue: 'old', newValue: 'first' } }],
      ['local', { changed: { oldValue: 'first', newValue: 'second' } }]
    ])
  })

  it('stores the values passed, not later changes to the same objects', async () => {
    const worker = install('worker')
    worker.listen()
    const items = { changed: { count: 1 } }
    const written = call(worker.chrome, 'storage.local.set', items)
    items.changed.count = 2
    await written
    expect(worker.local.data.get('changed')).toEqual({ count: 1 })
    expect(worker.all).toEqual([
      ['local', { changed: { oldValue: 'old', newValue: { count: 1 } } }]
    ])
  })

  it('keeps callback and promise semantics, with lastError only inside a failed callback', async () => {
    const worker = install('worker')
    worker.listen()
    const callback = vi.fn()
    expect(call(worker.chrome, 'storage.local.set', { changed: 'cb' }, callback)).toBeUndefined()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith())

    worker.local.failNextWrite('QUOTA_BYTES quota exceeded')
    const lastError = await new Promise((resolve) =>
      call(worker.chrome, 'storage.local.set', { changed: 'big' }, () =>
        resolve(worker.chrome.runtime.lastError?.message)
      )
    )
    expect(lastError).toBe('QUOTA_BYTES quota exceeded')
    expect(worker.chrome.runtime.lastError).toBeUndefined()

    worker.local.failNextWrite('QUOTA_BYTES quota exceeded')
    await expect(call(worker.chrome, 'storage.local.set', { changed: 'big' })).rejects.toThrow(
      'QUOTA_BYTES quota exceeded'
    )
    expect(worker.all).toEqual([['local', { changed: { oldValue: 'old', newValue: 'cb' } }]])
    // A shape the native call rejects still throws synchronously from it.
    expect(() => call(worker.chrome, 'storage.local.set', 'not-items')).toThrow(
      'Error in invocation of storage.set'
    )
  })

  it('replaces native onChanged and delivers changes main relays from extension pages', async () => {
    const worker = install('worker')
    expect(worker.chrome.storage.onChanged).not.toEqual({ native: true })
    worker.listen()
    worker.emit([{ token: { newValue: 'abc' } }, 'session'])
    expect(worker.all).toEqual([['session', { token: { newValue: 'abc' } }]])
    expect(worker.perArea).toEqual([['session', { token: { newValue: 'abc' } }]])
  })
})

describe('installBrowserExtensionStorageRelay in an extension page', () => {
  it('reports its own changed keys to main and leaves the native onChanged alone', async () => {
    const page = install('page')
    expect(page.chrome.storage.onChanged).toEqual({ native: true })
    expect(page.local.area.onChanged).toEqual({ native: true })
    expect(page.hasEventHandler()).toBe(false)

    await call(page.chrome, 'storage.local.set', { kept: 'same', changed: 'new' })
    await call(page.chrome, 'storage.local.set', { kept: 'same' })
    await call(page.chrome, 'storage.local.clear')
    await settle()
    expect(page.calls).toEqual([
      [
        PRELOAD_STORAGE_RELAY_NAMESPACE,
        'report',
        ['local', { changed: { oldValue: 'old', newValue: 'new' } }]
      ],
      [
        PRELOAD_STORAGE_RELAY_NAMESPACE,
        'report',
        [
          'local',
          {
            kept: { oldValue: 'same' },
            changed: { oldValue: 'new' },
            gone: { oldValue: 1 }
          }
        ]
      ]
    ])
    expect(page.local.data.size).toBe(0)
  })
})
