import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { expect, vi } from 'vitest'
import type SyncDatabase from '../../sqlite/sync-database'

/** Observe the real generation's collections, including copies through iterators and reverse edges. */
export function observeMailHistoryWork(owner: object) {
  const seen = new WeakSet<object>()
  const restores: (() => void)[] = []
  const counts = {
    reads: 0,
    writes: 0,
    visits: 0,
    selections: 0,
    serializations: 0,
    bytes: 0,
    sorted: 0
  }
  const wrap = (
    value: object,
    key: PropertyKey,
    invoke: (fn: (...args: unknown[]) => unknown, args: unknown[]) => unknown
  ) => {
    const fn = Reflect.get(value, key)
    if (typeof fn !== 'function') {
      throw new Error(`missing observed method ${String(key)}`)
    }
    const prior = Object.getOwnPropertyDescriptor(value, key)
    Object.defineProperty(value, key, {
      configurable: true,
      value: (...args: unknown[]) => invoke(fn, args)
    })
    restores.push(() => {
      if (prior) {
        Object.defineProperty(value, key, prior)
      } else {
        Reflect.deleteProperty(value, key)
      }
    })
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return
    }
    seen.add(value)
    if (value instanceof Map || value instanceof Set) {
      for (const item of value.values()) {
        visit(item)
      }
      for (const key of ['has', ...(value instanceof Map ? ['get'] : [])]) {
        wrap(value, key, (fn, args) => {
          counts.reads++
          const result = Reflect.apply(fn, value, args)
          visit(result)
          return result
        })
      }
      for (const key of ['delete', 'clear', value instanceof Map ? 'set' : 'add']) {
        wrap(value, key, (fn, args) => {
          counts.writes++
          args.forEach(visit)
          return Reflect.apply(fn, value, args)
        })
      }
      for (const key of ['entries', 'keys', 'values', Symbol.iterator]) {
        wrap(value, key, function* (fn, args) {
          const iterator = Reflect.apply(fn, value, args)
          if (!iterator || typeof iterator !== 'object' || !(Symbol.iterator in iterator)) {
            throw new Error('missing collection iterator')
          }
          // SAFETY: these are native Map/Set iterator methods, wrapped without replacing their results.
          for (const item of iterator as Iterable<unknown>) {
            counts.visits++
            visit(item)
            yield item
          }
        })
      }
    } else {
      Object.values(value).forEach(visit)
    }
  }
  for (const key of [
    'originals',
    'drafts',
    'evidence',
    'references',
    'sessions',
    'roots',
    'lineages',
    'counts',
    'members',
    'wake'
  ]) {
    visit(Reflect.get(owner, key))
  }
  wrap(owner, 'updateOperation', (fn, args) => {
    counts.selections++
    return Reflect.apply(fn, owner, args)
  })
  const stringify = JSON.stringify
  const json = vi.spyOn(JSON, 'stringify').mockImplementation((...args) => {
    const result = Reflect.apply(stringify, JSON, args)
    counts.serializations++
    counts.bytes += typeof result === 'string' ? Buffer.byteLength(result) : 0
    return result
  })
  const sort = Array.prototype.sort
  const sorting = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (
    this: unknown[],
    ...args
  ) {
    counts.sorted += this.length
    return Reflect.apply(sort, this, args)
  })
  return {
    snapshot: () => ({ ...counts }),
    reset: () => {
      for (const key of Object.keys(counts)) {
        Reflect.set(counts, key, 0)
      }
    },
    restore: () => {
      sorting.mockRestore()
      json.mockRestore()
      for (const restore of restores.toReversed()) {
        restore()
      }
    }
  }
}

/** Count indexed candidates; retain every binding and bytecode, rather than inferring visits from SEARCH. */
export function observeMailSqlWork(
  database: SyncDatabase,
  matches: (sql: string) => boolean,
  expression: string,
  predicate: boolean | 'visits' = false
) {
  const native = z
    .instanceof(DatabaseSync)
    .parse(Object.getOwnPropertyDescriptor(database, 'db')?.value)
  let evaluations = 0
  let evaluatedBytes = 0
  let observing = true
  const statements: {
    original: string
    instrumented: string
    args: SQLInputValue[]
    rows: number
    bytes: number
    method: 'all' | 'get' | 'iterate'
  }[] = []
  const seen = new WeakSet()
  native.function('observe_mail_work', { deterministic: true }, (value) => {
    if (observing) {
      evaluations++
      evaluatedBytes += typeof value === 'string' ? Buffer.byteLength(value) : 0
    }
    return value
  })
  const prepare = database.prepare.bind(database)
  const spy = vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    if (!matches(sql)) {
      return prepare(sql)
    }
    expect(sql).toContain(expression)
    const instrumented =
      predicate === 'visits'
        ? sql.replace('WHERE', `WHERE observe_mail_work(${expression}) IS NOT NULL AND`)
        : predicate
          ? sql.replace('ORDER BY', `AND observe_mail_work(${expression}) IS NOT NULL ORDER BY`)
          : sql.replace(expression, `observe_mail_work(${expression}) AS ${expression}`)
    const statement = prepare(instrumented)
    if (!seen.has(statement)) {
      seen.add(statement)
      const record = <T>(
        method: 'all' | 'get' | 'iterate',
        args: SQLInputValue[],
        result: T
      ): T => {
        statements.push({
          original: sql,
          instrumented,
          args,
          method,
          rows: Array.isArray(result) ? result.length : result ? 1 : 0,
          bytes: result ? Buffer.byteLength(JSON.stringify(result)) : 0
        })
        return result
      }
      const all = statement.all.bind(statement)
      const get = statement.get.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => record('all', args, all(...args)))
      vi.spyOn(statement, 'get').mockImplementation((...args) => record('get', args, get(...args)))
      const iterate = statement.iterate.bind(statement)
      vi.spyOn(statement, 'iterate').mockImplementation(function* (...args) {
        for (const row of iterate(...args)) {
          yield record('iterate', args, row)
        }
      })
    }
    return statement
  })
  return {
    count: () => evaluations,
    evaluatedBytes: () => evaluatedBytes,
    calls: statements,
    reset: () => {
      evaluations = 0
      evaluatedBytes = 0
      statements.length = 0
    },
    verify: () => {
      expect(statements.length).toBeGreaterThan(0)
      observing = false
      try {
        return statements.map(({ original, instrumented, args, method }) => {
          const plan = (sql: string) =>
            native
              .prepare(`EXPLAIN QUERY PLAN ${sql}`)
              .all(...args)
              .map((row) => row.detail)
          expect(plan(instrumented)).toEqual(plan(original))
          const readRows = (sql: string) =>
            method === 'iterate'
              ? [...native.prepare(sql).iterate(...args)]
              : method === 'all'
                ? native.prepare(sql).all(...args)
                : native.prepare(sql).get(...args)
          expect(readRows(instrumented)).toEqual(readRows(original))
          const bytecode = native.prepare(`EXPLAIN ${original}`).all(...args)
          if (predicate === true) {
            const opcodes = bytecode.map((row) => row.opcode)
            expect(opcodes).toContain('SeekGT')
            expect(opcodes).toContain('IdxGT')
            expect(opcodes.filter((op) => op === 'Next')).toHaveLength(1)
            expect(opcodes).not.toContain('Rewind')
            expect(opcodes).not.toContain('SorterOpen')
          }
          return { args, bytecode }
        })
      } finally {
        observing = true
      }
    },
    restore: () => spy.mockRestore()
  }
}
