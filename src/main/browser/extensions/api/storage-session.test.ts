import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
  windows: [] as { destroy: () => void }[],
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
  events: [] as unknown[],
  stores: new Map<unknown, Record<string, unknown>>(),
  levels: new Map<unknown, string>(),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
  dispatch: null as null | ((method: string, args: unknown[], finish: () => void) => void),
  holdDestroy: false,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
  destruction: [] as (() => void)[]
}))
vi.mock('electron', () => ({
  webFrameMain: {},
  BrowserWindow: class {
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => this.destroyed,
      executeJavaScript: (code: string) => runInNewContext(code, { chrome: this.chrome, atob })
    })
    destroyed = false
    chrome: {
      runtime: { lastError?: { message: string } }
      storage: { session: Record<string, unknown>; local: { clear: () => unknown } }
    }
    constructor(options: { webPreferences: { session: unknown } }) {
      fixture.windows.push(this)
      const owner = options.webPreferences.session
      const runtime: { lastError?: { message: string } } = {}
      if (!fixture.stores.has(owner)) {
        fixture.stores.set(owner, {})
      }
      const call = (method: string, ...input: unknown[]): unknown => {
        if (typeof input.at(-1) !== 'function') {
          return new Promise((resolve, reject) => {
            call(method, ...input, (value: unknown) =>
              runtime.lastError ? reject(new Error(runtime.lastError.message)) : resolve(value)
            )
          })
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
        const callback = input.pop() as (value?: unknown) => void
        const finish = () => {
          const current = fixture.stores.get(owner)!
          const [selection] = input
          let value: unknown
          if (method === 'set') {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
            if ((selection as Record<string, unknown>).overQuota) {
              runtime.lastError = { message: 'native quota exceeded' }
              callback()
              delete runtime.lastError
              return
            }
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
            fixture.stores.set(owner, { ...current, ...(selection as Record<string, unknown>) })
          } else if (method === 'get') {
            value =
              selection == null
                ? { ...current }
                : Object.fromEntries(
                    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
                    ([selection].flat() as string[]).flatMap((key) =>
                      Object.hasOwn(current, key) ? [[key, current[key]]] : []
                    )
                  )
          } else if (method === 'clear') {
            fixture.stores.set(owner, {})
          } else if (method === 'remove') {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
            for (const key of [selection].flat() as string[]) {
              delete current[key]
            }
          } else if (method === 'getBytesInUse') {
            value = 73
          } else if (method === 'setAccessLevel') {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
            fixture.levels.set(owner, (selection as { accessLevel: string }).accessLevel)
          }
          callback(value)
        }
        if (fixture.dispatch) {
          fixture.dispatch(method, input, finish)
        } else {
          finish()
        }
        return undefined
      }
      this.chrome = {
        runtime,
        storage: {
          local: { clear: () => call('clearLocal') },
          session: Object.fromEntries(
            ['set', 'get', 'clear', 'remove', 'getBytesInUse', 'setAccessLevel'].map((method) => [
              method,
              (...args: unknown[]) => call(method, ...args)
            ])
          )
        }
      }
    }
    loadURL() {
      return Promise.resolve()
    }
    destroy() {
      const finish = () => {
        this.destroyed = true
        this.webContents.emit('destroyed')
      }
      if (fixture.holdDestroy) {
        fixture.destruction.push(finish)
      } else {
        finish()
      }
    }
  }
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: (...args: unknown[]) => {
    fixture.events.push(args)
  }
}))
vi.mock('../api-runtime/browser-extension-worker-delivery', () => ({
  acknowledgeBrowserExtensionWorkerDelivery: () => {}
}))
vi.mock('node:timers/promises', () => ({ setImmediate: () => Promise.resolve() }))
import { ensureHostSessionState } from '../api-runtime/browser-extension-contexts'
import {
  beginBrowserExtensionExecution,
  retireBrowserExtensionExecution
} from '../api-runtime/browser-extension-execution-authority'
import {
  getBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'
import { registerStorageSessionNamespace } from './storage-session'
import { clearBrowserExtensionSessionData } from '../profile-storage/browser-extension-data-removal'
import {
  browserExtensionUntrustedSessionAccess,
  runBrowserExtensionSessionTransaction
} from '../profile-storage/browser-extension-session-access'
import {
  emitBrowserExtensionContentSessionChange,
  handleBrowserExtensionContentRequest
} from '../api-runtime/browser-extension-content-api-host'
import * as wire from '../../../../shared/browser/extensions/browser-extension-worker-api'
import {
  decodeBrowserExtensionWireJson,
  encodeBrowserExtensionWireJson
} from '../../../../shared/browser/extensions/browser-extension-worker-api'

registerStorageSessionNamespace()
function open(extensionId = 'vault') {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
  const extension = {
    id: extensionId,
    manifest: { permissions: ['storage'] }
  } as Electron.Extension
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
  const session = {
    storagePath: mkdtempSync(join(tmpdir(), 'orca-session-oracle-')),
    getStoragePath: () => null,
    clearStorageData: async () => {},
    extensions: { getExtension: () => extension }
  } as unknown as Electron.Session
  ensureHostSessionState(session, 'work')
  const reopen = () => {
    const execution = beginBrowserExtensionExecution(
      session,
      extensionId,
      new AbortController().signal
    )
    return {
      session,
      execution,
      extension,
      browserProfileId: 'work'
    } satisfies BrowserExtensionCaller
  }
  return { caller: reopen(), reopen, session }
}
function call(caller: BrowserExtensionCaller, method: string, args: unknown[] = []) {
  return getBrowserExtensionNamespace('orcaStorageSession')!.methods[method].invoke(caller, args)
}
async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}
afterEach(() => {
  fixture.dispatch = null
  fixture.holdDestroy = false
  for (const finish of fixture.destruction.splice(0)) {
    finish()
  }
  fixture.windows = []
  fixture.events = []
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('keeps the session oracle consistent while uninstall clears the still-loaded local database', async () => {
  const id = 'a'.repeat(32)
  const { caller, session } = open(id)
  await call(caller, 'set', [{ saved: 'committed' }])
  let release = (): void => {}
  let localClearStarted = false
  fixture.dispatch = (method, _args, finish) => {
    if (method === 'clearLocal') {
      localClearStarted = true
      release = finish
    } else {
      finish()
    }
  }
  const removing = clearBrowserExtensionSessionData(session, id)
  try {
    await flush()
    expect(localClearStarted).toBe(true)
    await call(caller, 'set', [{ another: 'accepted' }])
    expect(fixture.stores.get(session)).toEqual({ saved: 'committed', another: 'accepted' })
    expect(await call(caller, 'get', [null])).toEqual({ saved: 'committed', another: 'accepted' })
  } finally {
    release()
    await removing
    await retireBrowserExtensionExecution(session, id)
  }
})

it.each([750, 7500])(
  'touches only requested canonical entries during small mutations with %i retained keys',
  async (count) => {
    const { caller, session } = open()
    await call(caller, 'set', [
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`key${index}`, index]))
    ])
    let inventories = 0
    let reads = 0
    await runBrowserExtensionSessionTransaction(session, 'vault', (state) => {
      const values = state.values.get('vault')!
      state.values.set(
        'vault',
        new Proxy(values, {
          ownKeys(target) {
            inventories++
            return Reflect.ownKeys(target)
          },
          get(target, key) {
            if (typeof key === 'string') {
              reads++
            }
            return typeof key === 'string' ? target[key] : undefined
          }
        })
      )
    })
    await call(caller, 'set', [{ key0: 'changed' }])
    await call(caller, 'set', [{ key0: 'changed' }])
    await call(caller, 'set', [{}])
    await call(caller, 'remove', ['absent'])
    expect(inventories).toBe(0)
    // Three requested keys need at most a comparison and an old event value each.
    expect(reads).toBeLessThanOrEqual(6)
    expect(await call(caller, 'get', ['key0'])).toEqual({ key0: 'changed' })
    await retireBrowserExtensionExecution(session, 'vault')
  }
)

it.each([10, 100])('encodes one canonical event once for %i content subscribers', async (count) => {
  const { caller, session } = open()
  await call(caller, 'setAccessLevel', [{ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }])
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
  for (let index = 0; index < count; index++) {
    const response = await handleBrowserExtensionContentRequest(
      session,
      new Request('https://orca-extension/events', {
        method: 'POST',
        body: `${JSON.stringify({ token: caller.execution.contentToken, context: `frame-${index}` })}\n`
      })
    )
    expect(response.status).toBe(200)
    readers.push(response.body!.getReader())
  }
  const encode = vi.spyOn(wire, 'encodeBrowserExtensionWireJson')
  const changes = { saved: { newValue: 'shared' } }
  emitBrowserExtensionContentSessionChange(caller.execution, changes)
  expect(encode).toHaveBeenCalledTimes(1)
  for (const reader of readers) {
    const chunk = await reader.read()
    expect(decodeBrowserExtensionWireJson(new TextDecoder().decode(chunk.value).trim())).toEqual({
      namespace: 'orcaStorageSession',
      event: 'onChanged',
      args: [changes]
    })
    await reader.cancel()
  }
  await retireBrowserExtensionExecution(session, 'vault')
})

it('authenticates restricted content requests before reading payload and admits a 128 KiB session value', async () => {
  const { caller, session } = open()
  await call(caller, 'setAccessLevel', [{ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }])
  let reads = 0
  const canceled = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
  const unauthenticated = new Request('https://orca-extension/call', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++
          controller.enqueue(new TextEncoder().encode('{"token":"invalid"}\n'))
        },
        cancel: canceled
      },
      { highWaterMark: 0 }
    ),
    duplex: 'half'
  } as RequestInit)
  expect((await handleBrowserExtensionContentRequest(session, unauthenticated)).status).toBe(403)
  expect(reads).toBe(1)
  expect(canceled).toHaveBeenCalledOnce()
  const post = async (method: string, args: unknown[]) => {
    const response = await handleBrowserExtensionContentRequest(
      session,
      new Request('https://orca-extension/call', {
        method: 'POST',
        body: `${JSON.stringify({ token: caller.execution.contentToken, context: 'frame', method })}\n${encodeBrowserExtensionWireJson(args)}`
      })
    )
    const text = await response.text()
    return { status: response.status, value: text ? decodeBrowserExtensionWireJson(text) : null }
  }
  const value = 'x'.repeat(128 * 1024)
  expect(await post('set', [{ large: value }])).toEqual({
    status: 200,
    value: { ok: true, value: { large: { newValue: value } } }
  })
  expect(await post('get', ['large'])).toEqual({
    status: 200,
    value: { ok: true, value: { large: value } }
  })
  expect((await post('setAccessLevel', [{ accessLevel: 'TRUSTED_CONTEXTS' }])).status).toBe(403)
  await retireBrowserExtensionExecution(session, 'vault')
})

it('refuses an oversized authenticated chunk before dispatching a content mutation', async () => {
  const { caller, session } = open()
  await call(caller, 'setAccessLevel', [{ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }])
  const canceled = vi.fn()
  let reads = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
  const request = new Request('https://orca-extension/call', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++
          controller.enqueue(
            reads === 1
              ? new TextEncoder().encode(
                  `${JSON.stringify({ token: caller.execution.contentToken, context: 'frame', method: 'set' })}\n`
                )
              : new Uint8Array(64 * 1024 * 1024 + 1)
          )
        },
        cancel: canceled
      },
      { highWaterMark: 0 }
    ),
    duplex: 'half'
  } as RequestInit)
  expect((await handleBrowserExtensionContentRequest(session, request)).status).toBe(413)
  expect(canceled).toHaveBeenCalledOnce()
  expect(await call(caller, 'get', [null])).toEqual({})
  await retireBrowserExtensionExecution(session, 'vault')
})

it('keeps atomic canonical values and one change across native quota rejection, suspension and hydration', async () => {
  const { caller, reopen, session } = open()
  await call(caller, 'set', [{ saved: { nested: ['retained'] } }])
  await expect(call(caller, 'set', [{ saved: 'lost', overQuota: true }])).rejects.toThrow(
    'native quota'
  )
  expect(await call(caller, 'get', [null])).toEqual({ saved: { nested: ['retained'] } })
  expect(fixture.events).toHaveLength(1)
  await retireBrowserExtensionExecution(session, 'vault')
  const next = reopen()
  await expect(call(next, 'getBytesInUse')).resolves.toBe(73)
  expect(await call(next, 'get', [null])).toEqual({ saved: { nested: ['retained'] } })
  expect(fixture.stores.get(session)).toEqual({ saved: { nested: ['retained'] } })
  expect(fixture.events).toHaveLength(1)
  await call(next, 'set', [{ another: 'value' }])
  expect(fixture.windows).toHaveLength(2)
  await retireBrowserExtensionExecution(session, 'vault')
})

it('hydrates a finite multi-batch snapshot even when successful dispatches exceed 2.5 seconds in total', async () => {
  const { caller, reopen, session } = open()
  const items = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`item${i}`, i]))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
  items.large = 'x'.repeat(300_000) as unknown as number
  await call(caller, 'set', [items])
  await retireBrowserExtensionExecution(session, 'vault')
  const next = reopen()
  vi.useFakeTimers()
  fixture.dispatch = (method, _args, finish) => {
    setTimeout(finish, method === 'set' ? 2000 : 0)
  }
  const bytes = call(next, 'getBytesInUse')
  await flush()
  await vi.runAllTimersAsync()
  await expect(bytes).resolves.toBe(73)
  expect(fixture.stores.get(session)).toEqual(items)
  expect(await call(next, 'get', [null])).toEqual(items)
  await retireBrowserExtensionExecution(session, 'vault')
})

it('does not let a successor writer pass an uncertain old native effect before actual receiver teardown', async () => {
  const { caller, reopen, session } = open()
  await call(caller, 'set', [{ saved: 'committed' }])
  let held = false
  fixture.dispatch = (method, args, finish) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
    if (method === 'set' && (args[0] as Record<string, unknown>).saved === 'uncommitted') {
      fixture.stores.set(session, { saved: 'uncommitted' })
      held = true
    } else {
      finish()
    }
  }
  const pending = call(caller, 'set', [{ saved: 'uncommitted' }])
  const failure = expect(pending).rejects.toThrow('unloaded')
  await flush()
  expect(held).toBe(true)
  fixture.holdDestroy = true
  const retiring = retireBrowserExtensionExecution(session, 'vault')
  const next = reopen()
  const successor = call(next, 'set', [{ next: 'accepted' }])
  await flush()
  expect(fixture.stores.get(session)).toEqual({ saved: 'uncommitted' })
  fixture.holdDestroy = false
  for (const finish of fixture.destruction.splice(0)) {
    finish()
  }
  await failure
  await retiring
  await successor
  expect(await call(next, 'get', [null])).toEqual({ saved: 'committed', next: 'accepted' })
  expect(fixture.stores.get(session)).toEqual({ saved: 'committed', next: 'accepted' })
  await retireBrowserExtensionExecution(session, 'vault')
})

it('reconciles an uncertain retired native access setter before a successor can commit its grant', async () => {
  const { caller, reopen, session } = open()
  await call(caller, 'get', [null])
  let held = false
  fixture.dispatch = (method, args, finish) => {
    if (method === 'setAccessLevel' && !held) {
      held = true
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
      fixture.levels.set(session, (args[0] as { accessLevel: string }).accessLevel)
    } else {
      finish()
    }
  }
  const pending = call(caller, 'setAccessLevel', [
    { accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }
  ])
  const failure = expect(pending).rejects.toThrow('unloaded')
  await flush()
  expect(held).toBe(true)
  expect(browserExtensionUntrustedSessionAccess(session, 'vault')).toBe(false)
  fixture.holdDestroy = true
  const retiring = retireBrowserExtensionExecution(session, 'vault')
  const next = reopen()
  const grant = call(next, 'setAccessLevel', [{ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }])
  await flush()
  expect(browserExtensionUntrustedSessionAccess(session, 'vault')).toBe(false)
  fixture.holdDestroy = false
  for (const finish of fixture.destruction.splice(0)) {
    finish()
  }
  await failure
  await retiring
  await grant
  expect(browserExtensionUntrustedSessionAccess(session, 'vault')).toBe(true)
  expect(fixture.levels.get(session)).toBe('TRUSTED_AND_UNTRUSTED_CONTEXTS')
  await retireBrowserExtensionExecution(session, 'vault')
})

it('keeps committed state and ends a failed middle hydration without retrying or querying a partial mirror', async () => {
  const { caller, reopen, session } = open()
  const items = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`item${i}`, i]))
  await call(caller, 'set', [items])
  await retireBrowserExtensionExecution(session, 'vault')
  const next = reopen()
  fixture.dispatch = (method, args, finish) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned native-oracle fixture supplies the exact value or callback shape used at this boundary.
    if (method === 'set' && Object.hasOwn(args[0] as object, 'item1024')) {
      throw new Error('native batch failed')
    }
    if (method === 'getBytesInUse') {
      throw new Error('partial mirror queried')
    }
    finish()
  }
  await expect(call(next, 'getBytesInUse')).rejects.toThrow('native batch failed')
  expect(await call(next, 'get', [null])).toEqual(items)
  expect(fixture.windows).toHaveLength(2)
  expect(fixture.events).toHaveLength(1)
  await retireBrowserExtensionExecution(session, 'vault')
})
