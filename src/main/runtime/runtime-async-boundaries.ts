// Why: a throwing subscriber must not abort its emitter or leak a held mutation lock.
export function notifyRuntimeListeners<L>(
  listeners: Iterable<L>,
  deliver: (listener: L) => void,
  context: string
): void {
  for (const listener of listeners) {
    try {
      deliver(listener)
    } catch (error) {
      console.error(`[runtime] ${context} listener threw`, error)
    }
  }
}

export function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number
): void {
  if (map.has(key)) {
    map.delete(key)
  }
  map.set(key, value)
  while (map.size > maxEntries) {
    const oldest = map.keys().next()
    if (oldest.done) {
      return
    }
    map.delete(oldest.value)
  }
}

import { withTimeout } from '../../shared/promise-timeout-fallback'

export { withTimeout }

export function withTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ ok: true; value: T } | { ok: false }> {
  return withTimeout(
    promise.then((value) => ({ ok: true, value }) as const),
    timeoutMs,
    { ok: false }
  )
}
