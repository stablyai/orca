type CapturedCall<Result> = (...args: any[]) => Result

type ArrayVisitMethod = (callback: (...values: unknown[]) => unknown, thisArg?: unknown) => unknown

export function countProofWork() {
  let work = 0,
    mapEntryVisits = 0
  const get = Map.prototype.get,
    set = Map.prototype.set,
    has = Set.prototype.has,
    add = Set.prototype.add,
    iterator = Set.prototype[Symbol.iterator]
  const push = Array.prototype.push,
    arrayIterator = Array.prototype[Symbol.iterator],
    split = String.prototype.split
  const map = Array.prototype.map,
    filter = Array.prototype.filter,
    flatMap = Array.prototype.flatMap
  const stringIterator = String.prototype[Symbol.iterator],
    startsWith = String.prototype.startsWith,
    endsWith = String.prototype.endsWith,
    slice = String.prototype.slice
  const entries = Map.prototype[Symbol.iterator],
    values = Map.prototype.values
  const arraySlice = Array.prototype.slice,
    stringify = JSON.stringify
  const some = Array.prototype.some,
    every = Array.prototype.every,
    find = Array.prototype.find,
    sort = Array.prototype.sort
  const width = (value: unknown): number =>
    typeof value === 'string'
      ? value.length
      : value && typeof value === 'object' && 'ref' in value && typeof value.ref === 'string'
        ? value.ref.length
        : 1
  Map.prototype[Symbol.iterator] = new Proxy(entries, {
    apply(fn: CapturedCall<ReturnType<typeof entries>>, receiver, args) {
      work += receiver.size
      mapEntryVisits += receiver.size
      return fn.apply(receiver, args)
    }
  })
  Map.prototype.values = new Proxy(values, {
    apply(fn: CapturedCall<ReturnType<typeof values>>, receiver, args) {
      work += receiver.size
      return fn.apply(receiver, args)
    }
  })
  String.prototype[Symbol.iterator] = new Proxy(stringIterator, {
    apply(fn: CapturedCall<ReturnType<typeof stringIterator>>, receiver, args) {
      work += String(receiver).length
      return fn.apply(receiver, args)
    }
  })
  String.prototype.startsWith = new Proxy(startsWith, {
    apply(fn: CapturedCall<ReturnType<typeof startsWith>>, receiver, args) {
      work += String(args[0]).length
      return fn.apply(receiver, args)
    }
  })
  String.prototype.endsWith = new Proxy(endsWith, {
    apply(fn: CapturedCall<ReturnType<typeof endsWith>>, receiver, args) {
      work += String(args[0]).length
      return fn.apply(receiver, args)
    }
  })
  String.prototype.slice = new Proxy(slice, {
    apply(fn: CapturedCall<ReturnType<typeof slice>>, receiver, args) {
      const result = fn.apply(receiver, args)
      work += result.length
      return result
    }
  })
  Map.prototype.get = new Proxy(get, {
    apply(fn: CapturedCall<ReturnType<typeof get>>, receiver, args) {
      work += width(args[0])
      return fn.apply(receiver, args)
    }
  })
  Map.prototype.set = new Proxy(set, {
    apply(fn: CapturedCall<ReturnType<typeof set>>, receiver, args) {
      work += width(args[0])
      return fn.apply(receiver, args)
    }
  })
  Set.prototype.has = new Proxy(has, {
    apply(fn: CapturedCall<ReturnType<typeof has>>, receiver, args) {
      work += width(args[0])
      return fn.apply(receiver, args)
    }
  })
  Set.prototype.add = new Proxy(add, {
    apply(fn: CapturedCall<ReturnType<typeof add>>, receiver, args) {
      work += width(args[0])
      return fn.apply(receiver, args)
    }
  })
  Set.prototype[Symbol.iterator] = new Proxy(iterator, {
    apply(fn: CapturedCall<ReturnType<typeof iterator>>, receiver, args) {
      work += receiver.size
      return fn.apply(receiver, args)
    }
  })
  Array.prototype.slice = new Proxy(arraySlice, {
    apply(fn: CapturedCall<ReturnType<typeof arraySlice>>, receiver, args) {
      const result = fn.apply(receiver, args)
      work += result.length
      return result
    }
  })
  JSON.stringify = new Proxy(stringify, {
    apply(fn: CapturedCall<ReturnType<typeof stringify>>, receiver, args) {
      const result = fn.apply(receiver, args)
      work += result?.length ?? 0
      return result
    }
  })
  Array.prototype.push = new Proxy(push, {
    apply(fn: CapturedCall<ReturnType<typeof push>>, receiver, args) {
      work += args.length
      return fn.apply(receiver, args)
    }
  })
  Array.prototype[Symbol.iterator] = new Proxy(arrayIterator, {
    apply(fn: CapturedCall<ReturnType<typeof arrayIterator>>, receiver, args) {
      work += receiver.length
      return fn.apply(receiver, args)
    }
  })
  const counted = <T extends ArrayVisitMethod>(method: T): T =>
    new Proxy(method, {
      apply(fn: ArrayVisitMethod, receiver, args) {
        const [rawCallback, thisArg] = args
        const callback: Parameters<ArrayVisitMethod>[0] = rawCallback
        const result = fn.call(
          receiver,
          (...values: unknown[]) => {
            work += 1
            return callback.apply(thisArg, values)
          },
          thisArg
        )
        work += Array.isArray(result) ? result.length : 0
        return result
      }
    })
  Array.prototype.sort = new Proxy(sort, {
    apply(fn: CapturedCall<ReturnType<typeof sort>>, receiver, args) {
      const compare: Parameters<typeof sort>[0] = args[0]
      return fn.call(receiver, (a: unknown, b: unknown) => {
        work += width(a) + width(b)
        return compare ? compare(a, b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
      })
    }
  })
  Array.prototype.map = counted(map)
  Array.prototype.filter = counted(filter)
  Array.prototype.flatMap = counted(flatMap)
  Array.prototype.some = counted(some)
  Array.prototype.every = counted(every)
  Array.prototype.find = counted(find)
  String.prototype.split = new Proxy(split, {
    apply(fn: CapturedCall<ReturnType<typeof split>>, receiver, args) {
      work += String(receiver).length
      return fn.apply(receiver, args)
    }
  })
  return {
    value: () => work,
    mapEntryVisits: () => mapEntryVisits,
    restore: () => {
      Map.prototype[Symbol.iterator] = entries
      Map.prototype.values = values
      String.prototype[Symbol.iterator] = stringIterator
      String.prototype.startsWith = startsWith
      String.prototype.endsWith = endsWith
      String.prototype.slice = slice
      Map.prototype.get = get
      Map.prototype.set = set
      Set.prototype.has = has
      Set.prototype.add = add
      Set.prototype[Symbol.iterator] = iterator
      Array.prototype.slice = arraySlice
      JSON.stringify = stringify
      Array.prototype.push = push
      Array.prototype[Symbol.iterator] = arrayIterator
      Array.prototype.map = map
      Array.prototype.filter = filter
      Array.prototype.flatMap = flatMap
      Array.prototype.some = some
      Array.prototype.every = every
      Array.prototype.find = find
      Array.prototype.sort = sort
      String.prototype.split = split
    }
  }
}
