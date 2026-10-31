/** Observe real closure-owned payloads without adding a product inspection API. */
export function captureOutcomeLifetime<T>(construct: () => T) {
  const NativeMap = globalThis.Map
  const maps: Map<unknown, unknown>[] = []
  globalThis.Map = new Proxy(NativeMap, {
    construct(target, args) {
      const map: unknown = Reflect.construct(target, args)
      if (!(map instanceof NativeMap)) {
        throw new Error('Expected a real constructed Map')
      }
      maps.push(map)
      return map
    }
  })
  let owner: T
  try {
    owner = construct()
  } finally {
    globalThis.Map = NativeMap
  }
  return {
    owner,
    pendingIds: () =>
      maps.flatMap((map) =>
        [...map.values()].flatMap((value) => {
          if (
            !value ||
            typeof value !== 'object' ||
            !('generation' in value) ||
            !('outcome' in value)
          ) {
            return []
          }
          const outcome = value.outcome
          if (!outcome || typeof outcome !== 'object' || !('run' in outcome)) {
            return []
          }
          const run = outcome.run
          return run && typeof run === 'object' && 'id' in run && typeof run.id === 'string'
            ? [run.id]
            : []
        })
      )
  }
}
