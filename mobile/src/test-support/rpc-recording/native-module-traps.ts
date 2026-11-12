// Partial modules reject unlisted member reads; stores allow references but reject undeclared calls.
// __esModule:true preserves proxies through default/star interop instead of copying away their traps.
// Stores answer undefined because the proxy itself is the default export; true would bind a throwing .default stub.
export function partialNativeModule(module: string, members: Record<string, unknown>): unknown {
  return new Proxy(members, {
    get: (target, key) => {
      if (typeof key === 'string') {
        if (key !== '__esModule' && !(key in target)) {
          throw new Error(`Unsubstituted native member: ${module}.${key}`)
        }
        return target[key]
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a symbol key cannot index the declared string record; the trap reads whatever the member object holds there.
      return (target as Record<symbol, unknown>)[key]
    }
  })
}

/** A device event source with no events: registration succeeds, nothing is ever delivered. */
export function silentNativeSubscription(): { remove: () => void } {
  return { remove: () => {} }
}

export function nativeStoreModule(module: string, declared: Record<string, unknown> = {}): unknown {
  return new Proxy(declared, {
    get: (target, key) => {
      if (key === '__esModule') {
        return undefined
      }
      if (typeof key === 'string' && key in target) {
        return target[key]
      }
      return (...args: unknown[]) => {
        void args
        throw new Error(`Native store reached during recording: ${module}.${String(key)}`)
      }
    }
  })
}
