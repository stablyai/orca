import { Session } from 'node:inspector/promises'
import { hasArrayKey, newCounts, operationStack } from './acp-history-scaling-counts.test-fixture'

type CountedArrayFactory = (
  this: ArrayConstructor,
  input: Iterable<unknown> | ArrayLike<unknown>,
  mapper?: (value: unknown, index: number) => unknown,
  thisArg?: unknown
) => unknown[]

// Count executed production blocks and built-in indexed reads, without replacing any result.
export async function work(run: (counts: ReturnType<typeof newCounts>) => Promise<void>) {
  const inspector = new Session()
  inspector.connect()
  const counts = newCounts()
  const sorted = Object.getOwnPropertyDescriptor(Array.prototype, 'toSorted')!
  const slice = Object.getOwnPropertyDescriptor(Array.prototype, 'slice')!
  const includes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!
  const some = Object.getOwnPropertyDescriptor(Array.prototype, 'some')!
  const values = Object.getOwnPropertyDescriptor(Map.prototype, 'values')!
  const from = Object.getOwnPropertyDescriptor(Array, 'from')!
  const get = Object.getOwnPropertyDescriptor(Map.prototype, 'get')!
  const set = Object.getOwnPropertyDescriptor(Map.prototype, 'set')!
  const has = Object.getOwnPropertyDescriptor(Set.prototype, 'has')!
  const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!
  const filter = Object.getOwnPropertyDescriptor(Array.prototype, 'filter')!
  const sortArray = Array.prototype.toSorted
  const sliceArray = Array.prototype.slice
  const arrayIncludes = Array.prototype.includes
  const arraySome = Array.prototype.some
  const setHas = Set.prototype.has
  const mapValues = Map.prototype.values
  const arrayFrom: CountedArrayFactory = Array.from
  const mapGet = Map.prototype.get
  const mapSet = Map.prototype.set
  const arrayMap = Array.prototype.map
  const arrayFilter = Array.prototype.filter
  const countedArray = (
    array: unknown[],
    counter: 'native' | 'suffix' | 'membership' | 'copies' | 'tree'
  ) =>
    new Proxy(array, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          counts[counter]++
        }
        return hasArrayKey(target, key) ? target[key] : undefined
      },
      set(target, key, value, receiver) {
        if (counter === 'tree' && typeof key === 'string' && /^\d+$/.test(key)) {
          counts.tree++
        }
        return Reflect.set(target, key, value, receiver)
      }
    })
  await inspector.post('Profiler.enable')
  await inspector.post('Debugger.enable')
  await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
  Object.defineProperty(Array.prototype, 'toSorted', {
    ...sorted,
    value: function (this: unknown[], compare?: (a: unknown, b: unknown) => number) {
      const result: unknown[] = sortArray.call(this, compare)
      return operationStack()?.split('\n')[2]?.includes('acp-history-turn-matching.ts')
        ? countedArray(result, 'native')
        : result
    }
  })
  Object.defineProperty(Array.prototype, 'slice', {
    ...slice,
    value: function (this: unknown[], start?: number, end?: number) {
      const result: unknown[] = sliceArray.call(this, start, end)
      return operationStack()?.split('\n')[2]?.includes('acp-history-turn-matching.ts')
        ? countedArray(result, 'suffix')
        : result
    }
  })
  Object.defineProperty(Array.prototype, 'includes', {
    ...includes,
    value: function (this: unknown[], value: unknown, start?: number) {
      const array = operationStack()?.split('\n')[2]?.includes('acp-history-replay.ts')
        ? countedArray(this, 'membership')
        : this
      return arrayIncludes.call(array, value, start)
    }
  })
  Object.defineProperty(Array.prototype, 'some', {
    ...some,
    value: function (
      this: unknown[],
      predicate: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown
    ) {
      const array = operationStack()
        ?.split('\n')[2]
        ?.includes('structuredAgentSessionRejectedShownInPlace')
        ? countedArray(this, 'copies')
        : this
      return arraySome.call(array, predicate, thisArg)
    }
  })
  Object.defineProperty(Array.prototype, 'map', {
    ...map,
    value: function (
      this: unknown[],
      callback: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown
    ) {
      const stack = operationStack()
      const caller = stack.split('\n')[2] ?? ''
      const provenance = caller.includes('providerTimelineExecutionItems')
      if (provenance) {
        counts.execution.push({
          phase: stack.split('\n')[3]?.trim() ?? '',
          construction: 0,
          predicates: 0,
          reciprocalReads: 0,
          executionItemIds: []
        })
      }
      if (caller.includes('journalView') && this.every((key) => typeof key === 'string')) {
        counts.views.at(-1)!.canonicalEntries += this.length
      }
      const result: unknown[] = arrayMap.call(this, (value, index, array) => {
        if (provenance) {
          counts.execution.at(-1)!.construction++
        }
        return callback.call(thisArg, value, index, array)
      })
      if (caller.includes('acp-history-translation.ts')) {
        counts.translatedItems += result.length
      }
      return result
    }
  })
  Object.defineProperty(Array.prototype, 'filter', {
    ...filter,
    value: function (
      this: unknown[],
      predicate: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown
    ) {
      const provenance = operationStack().split('\n')[2]?.includes('providerTimelineExecutionItems')
      const result: unknown[] = arrayFilter.call(this, (value, index, array) => {
        if (provenance) {
          counts.execution.at(-1)!.predicates++
        }
        return predicate.call(thisArg, value, index, array)
      })
      if (provenance) {
        const ids = counts.execution.at(-1)!.executionItemIds
        for (const item of result) {
          if (
            typeof item !== 'object' ||
            item === null ||
            !('itemId' in item) ||
            typeof item.itemId !== 'string'
          ) {
            throw new Error('expected execution journal item')
          }
          ids.push(item.itemId)
        }
      }
      return result
    }
  })
  Object.defineProperty(Set.prototype, 'has', {
    ...has,
    value: function (this: Set<unknown>, value: unknown) {
      if (operationStack()?.split('\n')[2]?.includes('acp-history-replay.ts')) {
        counts.membership++
      }
      return setHas.call(this, value)
    }
  })
  Object.defineProperty(Map.prototype, 'values', {
    ...values,
    value: function (this: Map<unknown, unknown>) {
      const iterator: IterableIterator<unknown> = mapValues.call(this)
      if (!operationStack().includes('acp-history-turn-matching.ts')) {
        return iterator
      }
      return (function* () {
        for (const value of iterator) {
          if (typeof value === 'number') {
            counts.adopted++
          }
          yield value
        }
      })()
    }
  })
  Object.defineProperty(Array, 'from', {
    ...from,
    value: function (
      this: ArrayConstructor,
      input: Iterable<unknown> | ArrayLike<unknown>,
      mapper?: (value: unknown, index: number) => unknown,
      thisArg?: unknown
    ) {
      const result = arrayFrom.call(this, input, mapper, thisArg)
      return operationStack().includes('acp-history-ordered-availability.ts')
        ? countedArray(result, 'tree')
        : result
    }
  })
  Object.defineProperty(Map.prototype, 'get', {
    ...get,
    value: function (this: Map<unknown, unknown>, key: unknown) {
      const stack = operationStack()
      if (stack.includes('structuredAgentSessionRejectedShownInPlace')) {
        counts.copies++
      }
      if (
        stack.includes('isHistoricalProviderTimelineItem') &&
        stack.includes('providerTimelineExecutionItems')
      ) {
        counts.execution.at(-1)!.reciprocalReads++
      }
      return mapGet.call(this, key)
    }
  })
  Object.defineProperty(Map.prototype, 'set', {
    ...set,
    value: function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      const stack = operationStack()
      if (stack.includes('structuredAgentSessionRejectedShownInPlace')) {
        counts.copies++
      }
      return mapSet.call(this, key, value)
    }
  })
  try {
    await run(counts)
    const coverage = await inspector.post('Profiler.takePreciseCoverage')
    for (const script of coverage.result) {
      const path = script.url.split('?')[0]
      if (
        !/acp-history-(ordered-availability|turn-matching)\.ts$|structured-agent-session-message-projection\.ts$/.test(
          path
        )
      ) {
        continue
      }
      for (const fn of script.functions) {
        const total = fn.ranges.reduce((sum, block) => sum + block.count, 0)
        if (path.endsWith('acp-history-turn-matching.ts')) {
          counts.matching += total
        }
      }
    }
    console.info('ACP history underlying work', JSON.stringify(counts))
    return counts
  } finally {
    Object.defineProperty(Array.prototype, 'toSorted', sorted)
    Object.defineProperty(Array.prototype, 'slice', slice)
    Object.defineProperty(Array.prototype, 'includes', includes)
    Object.defineProperty(Array.prototype, 'some', some)
    Object.defineProperty(Map.prototype, 'values', values)
    Object.defineProperty(Array, 'from', from)
    Object.defineProperty(Map.prototype, 'get', get)
    Object.defineProperty(Map.prototype, 'set', set)
    Object.defineProperty(Set.prototype, 'has', has)
    Object.defineProperty(Array.prototype, 'map', map)
    Object.defineProperty(Array.prototype, 'filter', filter)
    await inspector.post('Profiler.disable')
    await inspector.post('Debugger.disable')
    inspector.disconnect()
  }
}
