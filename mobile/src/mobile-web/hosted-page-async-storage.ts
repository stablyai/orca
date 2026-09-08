import { requestMobileWebPagePreferences } from '../../../src/mobile-web/src/mobile-web-page-preferences-channel'
import type {
  MobileWebPagePreferencesPayload,
  MobileWebPagePreferencesResult
} from '../../../src/shared/mobile-web/page-preferences-contract'

type Callback<T = void> = (error: Error | null, result?: T) => void
type Action = MobileWebPagePreferencesPayload['action']
type Operation = {
  action: Action
  keys: readonly string[]
  entries: readonly [string, string][]
  settle: (result: MobileWebPagePreferencesResult) => void
  reject: (error: unknown) => void
}

const namespace = 'expo.preferences'
// Keys/entries per request accepted by MobileWebPagePreferencesPayloadSchema.
const maxBatchItems = 64
const queue: Operation[] = []
let scheduled = false
let draining = false

function chunk<Item>(items: readonly Item[]): Item[][] {
  const parts: Item[][] = []
  for (let index = 0; index < items.length; index += maxBatchItems) {
    parts.push(items.slice(index, index + maxBatchItems))
  }
  return parts
}

function enqueue<T>(
  request: { action: Action; keys?: readonly string[]; entries?: readonly [string, string][] },
  settle: (result: MobileWebPagePreferencesResult) => T
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      action: request.action,
      keys: request.keys ?? [],
      entries: request.entries ?? [],
      settle: (result) => resolve(settle(result)),
      reject
    })
    if (!scheduled && !draining) {
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        void drain()
      })
    }
  })
}

// Adjacent same-action calls fold into one bridge request so a screen's
// concurrent preference reads stay inside the shell's request grant.
function takeBatch(): Operation[] {
  const first = queue.shift()!
  const batch = [first]
  if (first.action === 'keys' || first.action === 'clear') {
    return batch
  }
  let items = first.keys.length + first.entries.length
  while (queue[0]?.action === first.action) {
    const next = queue[0]!
    const combined = items + next.keys.length + next.entries.length
    if (combined > maxBatchItems) {
      break
    }
    items = combined
    batch.push(queue.shift()!)
  }
  return batch
}

function buildPayload(batch: readonly Operation[]): MobileWebPagePreferencesPayload {
  const first = batch[0]!
  if (first.action === 'keys' || first.action === 'clear') {
    return { namespace, action: first.action }
  }
  if (first.action === 'write') {
    const entries = new Map<string, string>()
    for (const operation of batch) {
      for (const [key, value] of operation.entries) {
        entries.set(key, value)
      }
    }
    return { namespace, action: 'write', entries: [...entries] }
  }
  const keys = new Set<string>()
  for (const operation of batch) {
    for (const key of operation.keys) {
      keys.add(key)
    }
  }
  return first.action === 'read'
    ? { namespace, action: 'read', keys: [...keys] }
    : { namespace, action: 'remove', keys: [...keys] }
}

async function drain(): Promise<void> {
  if (draining) {
    return
  }
  draining = true
  try {
    while (queue.length > 0) {
      const batch = takeBatch()
      try {
        const result = await requestMobileWebPagePreferences(buildPayload(batch))
        for (const operation of batch) {
          try {
            operation.settle(result)
          } catch (error: unknown) {
            operation.reject(error)
          }
        }
      } catch (error: unknown) {
        for (const operation of batch) {
          operation.reject(error)
        }
      }
    }
  } finally {
    draining = false
  }
}

function callbackResult<T>(work: Promise<T>, callback?: Callback<T>): Promise<T> {
  return work.then(
    (result) => {
      callback?.(null, result)
      return result
    },
    (error: unknown) => {
      const failure = error instanceof Error ? error : new Error('Page preferences unavailable')
      callback?.(failure)
      throw failure
    }
  )
}

function readEntries(result: MobileWebPagePreferencesResult, keys: readonly string[]) {
  if (!('entries' in result)) {
    throw new Error('Invalid page preference response')
  }
  const values = new Map(result.entries)
  return keys.map((key): [string, string | null] => [key, values.get(key) ?? null])
}

async function multiGet(keys: readonly string[]): Promise<[string, string | null][]> {
  const parts = await Promise.all(
    chunk(keys).map((part) =>
      enqueue({ action: 'read', keys: part }, (result) => readEntries(result, part))
    )
  )
  return parts.flat()
}
async function multiSet(entries: readonly [string, string][]): Promise<void> {
  await Promise.all(
    chunk(entries).map((part) => enqueue({ action: 'write', entries: part }, () => {}))
  )
}
async function multiRemove(keys: readonly string[]): Promise<void> {
  await Promise.all(chunk(keys).map((part) => enqueue({ action: 'remove', keys: part }, () => {})))
}
const storage = {
  getItem(key: string, callback?: Callback<string | null>) {
    return callbackResult(
      multiGet([key]).then((entries) => entries[0]?.[1] ?? null),
      callback
    )
  },
  setItem(key: string, value: string, callback?: Callback) {
    return callbackResult(multiSet([[key, value]]), callback)
  },
  removeItem(key: string, callback?: Callback) {
    return callbackResult(multiRemove([key]), callback)
  },
  clear(callback?: Callback) {
    return callbackResult(
      enqueue({ action: 'clear' }, () => {}),
      callback
    )
  },
  getAllKeys(callback?: Callback<string[]>) {
    return callbackResult(
      enqueue({ action: 'keys' }, (result) => {
        if (!('keys' in result)) {
          throw new Error('Invalid page preference response')
        }
        return result.keys
      }),
      callback
    )
  },
  multiGet(keys: readonly string[], callback?: Callback<[string, string | null][]>) {
    return callbackResult(multiGet(keys), callback)
  },
  multiSet(entries: readonly [string, string][], callback?: Callback) {
    return callbackResult(multiSet(entries), callback)
  },
  multiRemove(keys: readonly string[], callback?: Callback) {
    return callbackResult(multiRemove(keys), callback)
  },
  mergeItem(_key: string, _value: string, callback?: Callback) {
    return callbackResult(
      Promise.reject<void>(new Error('Use explicit page preference writes')),
      callback
    )
  },
  multiMerge(_entries: readonly [string, string][], callback?: Callback) {
    return callbackResult(
      Promise.reject<void>(new Error('Use explicit page preference writes')),
      callback
    )
  },
  flushGetRequests() {
    void drain()
  }
}
export function useAsyncStorage(key: string) {
  return {
    getItem: (callback?: Callback<string | null>) => storage.getItem(key, callback),
    setItem: (value: string, callback?: Callback) => storage.setItem(key, value, callback),
    removeItem: (callback?: Callback) => storage.removeItem(key, callback),
    mergeItem: (value: string, callback?: Callback) => storage.mergeItem(key, value, callback)
  }
}
export default storage
