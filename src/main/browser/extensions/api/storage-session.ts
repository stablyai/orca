import { setImmediate as yieldToMain } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { emitBrowserExtensionEvent } from '../api-runtime/browser-extension-api-host'
import { emitBrowserExtensionContentSessionChange } from '../api-runtime/browser-extension-content-api-host'
import {
  BrowserExtensionNativePage,
  browserExtensionNativeValue
} from '../api-runtime/browser-extension-native-page'
import {
  isBrowserExtensionExecutionLive,
  type BrowserExtensionExecution
} from '../api-runtime/browser-extension-execution-authority'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  extensionHasPermission,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'
import {
  browserExtensionUntrustedSessionAccess,
  runBrowserExtensionSessionTransaction,
  setBrowserExtensionSessionAccess
} from '../profile-storage/browser-extension-session-access'

type Items = Record<string, unknown>
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>
type Mirror = { page: BrowserExtensionNativePage; valid: boolean }
const mirrors = new WeakMap<BrowserExtensionExecution, Mirror>()
const keysSchema = z.union([z.string(), z.array(z.string())])
const getSchema = z.union([z.null(), keysSchema, z.record(z.string(), z.unknown())]).optional()

function requireCaller(caller: BrowserExtensionCaller): BrowserExtensionExecution {
  const execution = caller.execution
  if (!execution || !isBrowserExtensionExecutionLive(execution)) {
    throw new BrowserExtensionApiError('Extension context was unloaded')
  }
  const current = caller.session.extensions.getExtension(caller.extension.id)
  if (!current || !extensionHasPermission(current, 'storage', caller.session)) {
    throw new BrowserExtensionApiError('This API requires the "storage" permission')
  }
  if (caller.untrusted && !browserExtensionUntrustedSessionAccess(caller.session, current.id)) {
    throw new BrowserExtensionApiError('Access to storage is not allowed from this context.')
  }
  return execution
}

async function native(
  mirror: Mirror,
  method: string,
  args: unknown[],
  readStored = false
): Promise<unknown> {
  const code = `new Promise(resolve => { const args = ${browserExtensionNativeValue(args)}; chrome.storage.session[${JSON.stringify(method)}](...args, value => {
    if (chrome.runtime.lastError) { resolve({ok:false,error:chrome.runtime.lastError.message}); return }
    ${method === 'set' && readStored ? `chrome.storage.session.get(Object.keys(args[0]), stored => resolve(chrome.runtime.lastError ? {ok:false,effected:true,error:chrome.runtime.lastError.message} : {ok:true,value:stored}))` : 'resolve({ok:true,value})'}
  })})`
  const reply = await mirror.page.run(code, 2500)
  if (!reply || typeof reply !== 'object' || !('ok' in reply)) {
    throw new Error('Extension storage returned an invalid result')
  }
  if (reply.ok === false && 'error' in reply && typeof reply.error === 'string') {
    if ('effected' in reply && reply.effected === true) {
      throw new Error(reply.error)
    }
    throw new BrowserExtensionApiError(reply.error)
  }
  if (reply.ok !== true || !('value' in reply)) {
    throw new Error('Extension storage returned an invalid result')
  }
  return reply.value
}

async function invalidate(execution: BrowserExtensionExecution, mirror: Mirror): Promise<void> {
  mirror.valid = false
  if (mirrors.get(execution) === mirror) {
    mirrors.delete(execution)
  }
  await mirror.page.destroy()
}

/** One fixed snapshot, one forward pass. Scheduling targets never reject an indivisible value. */
async function hydrate(execution: BrowserExtensionExecution, current: Items): Promise<Mirror> {
  let mirror = mirrors.get(execution)
  if (mirror?.valid) {
    return mirror
  }
  if (mirror) {
    await invalidate(execution, mirror)
  }
  execution.controller.signal.throwIfAborted()
  mirror = { page: new BrowserExtensionNativePage(execution), valid: false }
  mirrors.set(execution, mirror)
  try {
    await native(mirror, 'clear', [])
    const entries = Object.entries(current)
    let cursor = 0
    while (cursor < entries.length) {
      execution.controller.signal.throwIfAborted()
      const batch: [string, unknown][] = []
      let bytes = 0
      while (cursor < entries.length && batch.length < 1024) {
        const entry = entries[cursor]
        const size = Buffer.byteLength(browserExtensionNativeValue(Object.fromEntries([entry])))
        if (batch.length > 0 && bytes + size > 256 * 1024) {
          break
        }
        batch.push(entry)
        bytes += size
        cursor++
      }
      await native(mirror, 'set', [Object.fromEntries(batch)])
      execution.controller.signal.throwIfAborted()
      await yieldToMain()
    }
    execution.controller.signal.throwIfAborted()
    if (!isBrowserExtensionExecutionLive(execution)) {
      throw new Error('Extension context was unloaded')
    }
    mirror.valid = true
    return mirror
  } catch (error) {
    await invalidate(execution, mirror)
    throw error
  }
}

function commit(
  caller: BrowserExtensionCaller,
  current: Items,
  accepted: Items | null,
  keys: Iterable<string>
): Changes {
  const changes: Changes = {}
  for (const key of new Set(keys)) {
    const had = Object.hasOwn(current, key)
    const has = accepted !== null && Object.hasOwn(accepted, key)
    const oldValue = had ? current[key] : undefined
    const newValue = has ? accepted![key] : undefined
    if ((had || has) && !(had && has && isDeepStrictEqual(oldValue, newValue))) {
      Object.defineProperty(changes, key, {
        value: {
          ...(had ? { oldValue } : {}),
          ...(has ? { newValue } : {})
        },
        enumerable: true
      })
    }
  }
  requireCaller(caller)
  for (const [key, change] of Object.entries(changes)) {
    if (Object.hasOwn(change, 'newValue')) {
      Object.defineProperty(current, key, {
        value: change.newValue,
        writable: true,
        configurable: true,
        enumerable: true
      })
    } else {
      delete current[key]
    }
  }
  return changes
}

async function run(
  caller: BrowserExtensionCaller,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const execution = requireCaller(caller)
  return runBrowserExtensionSessionTransaction(
    caller.session,
    caller.extension.id,
    async (state) => {
      requireCaller(caller)
      const current = state.values.get(caller.extension.id) ?? {}
      const [selection] = args
      if (method === 'get') {
        if (selection == null) {
          return { ...current }
        }
        if (typeof selection === 'string' || Array.isArray(selection)) {
          return Object.fromEntries(
            [selection]
              .flat()
              .flatMap((key) => (Object.hasOwn(current, key) ? [[key, current[key]]] : []))
          )
        }
        return Object.fromEntries(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The native get call already accepted this defaults object.
          Object.entries(selection as Items).map(([key, fallback]) => [
            key,
            Object.hasOwn(current, key) ? current[key] : fallback
          ])
        )
      }
      if (method === 'getKeys') {
        return Object.keys(current)
      }
      const writes = method !== 'getBytesInUse'
      let mirror = mirrors.get(execution)
      if (method === 'set' || method === 'getBytesInUse') {
        mirror = await hydrate(execution, current)
      }
      let effected = false
      try {
        let result: unknown
        if (mirror?.valid) {
          result = await native(mirror, method, args, method === 'set')
          effected = writes
        }
        requireCaller(caller)
        if (!writes) {
          return result
        }
        let accepted: Items | null = null
        let keys: string[]
        if (method === 'set') {
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error('Extension storage returned invalid values')
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The native get result was checked as a non-null non-array object above.
          accepted = result as Items
          keys = Object.keys(result)
        } else if (method === 'clear') {
          keys = Object.keys(current)
        } else {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Successful native remove validation guarantees a string key or string-key array.
          keys = [selection].flat() as string[]
        }
        const changes = commit(caller, current, accepted, keys)
        state.values.set(caller.extension.id, current)
        if (Object.keys(changes).length > 0) {
          emitBrowserExtensionEvent(
            { session: caller.session, extensionId: caller.extension.id, exceptCaller: caller },
            'orcaStorageSession',
            'onChanged',
            [changes]
          )
          emitBrowserExtensionContentSessionChange(execution, changes, caller.contentContext)
        }
        return changes
      } catch (error) {
        if (mirror && (!(error instanceof BrowserExtensionApiError) || effected)) {
          await invalidate(execution, mirror)
        }
        throw error
      }
    }
  )
}

export function forgetBrowserExtensionSessionValues(
  session: Electron.Session,
  extensionId: string
): Promise<void> {
  return runBrowserExtensionSessionTransaction(session, extensionId, (state) => {
    state.values.delete(extensionId)
  })
}

export function registerStorageSessionNamespace(): void {
  registerBrowserExtensionNamespace('orcaStorageSession', {
    permission: 'storage',
    methods: {
      get: defineBrowserExtensionMethod(z.tuple([getSchema]), (caller, keys) =>
        run(caller, 'get', [keys])
      ),
      getKeys: defineBrowserExtensionMethod(z.tuple([]), (caller) => run(caller, 'getKeys', [])),
      getBytesInUse: defineBrowserExtensionMethod(
        z.tuple([z.union([z.null(), keysSchema]).optional()]),
        (caller, keys) => run(caller, 'getBytesInUse', keys === undefined ? [] : [keys])
      ),
      set: defineBrowserExtensionMethod(
        z.tuple([z.record(z.string(), z.unknown())]),
        (caller, items) => run(caller, 'set', [items])
      ),
      remove: defineBrowserExtensionMethod(z.tuple([keysSchema]), (caller, keys) =>
        run(caller, 'remove', [keys])
      ),
      clear: defineBrowserExtensionMethod(z.tuple([]), (caller) => run(caller, 'clear', [])),
      setAccessLevel: defineBrowserExtensionMethod(
        z.tuple([
          z.object({ accessLevel: z.enum(['TRUSTED_CONTEXTS', 'TRUSTED_AND_UNTRUSTED_CONTEXTS']) })
        ]),
        (caller, options) => {
          const execution = requireCaller(caller)
          if (caller.untrusted) {
            throw new BrowserExtensionApiError(
              'This StorageArea is not available for setting access level'
            )
          }
          return setBrowserExtensionSessionAccess(
            caller.session,
            caller.extension.id,
            options.accessLevel,
            execution.controller.signal
          )
        }
      )
    },
    events: ['onChanged']
  })
}
