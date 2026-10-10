/**
 * The two traps a native substitute is built from.
 *
 * A partial module stands in for part of a package: the members a mounted operation reads, and a
 * refusal for the rest. A member nobody listed throws on the read rather than resolving to
 * `undefined`, because an undefined native member is not a recording of anything — the product
 * would call it. A store inverts that, reading every member back as a function that throws when
 * called: a default-dependency object may name them, and a recording that reaches one fails at the
 * call instead. Whether that failure is visible depends on the caller; `host-app-version-store.ts`
 * catches and degrades to its unread state, which is what it does on a device too.
 *
 * `__esModule` is exempt from both refusals, because it is the module system's interop marker rather
 * than a native API, and what a trap answers there is the whole of the interop rule for every
 * substitute in this directory — the other sites point here rather than restating it. Both emitted
 * helpers short-circuit on a truthy marker: `__importDefault` returns the module instead of wrapping
 * it, and `__importStar` returns it instead of copying its own keys into a fresh object.
 *
 * So a trap answers `true` when it has to survive being imported: the loader's refusing proxy, and
 * any partial whose consumer takes a default or a namespace, because a flattened copy has no trap
 * left and would answer an unlisted member with `undefined` instead of the named refusal. A store
 * answers `undefined`, because the store *is* the default export — a truthy marker would bind
 * `import X from` to the trap's own `default`, a throwing stub, instead of to the trap.
 */
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

/** A native store: the members a recording declared, and a throwing call for every other. */
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
