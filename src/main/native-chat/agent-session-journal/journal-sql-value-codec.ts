import { journalSqlCapturedPaths } from './journal-sql-captures'

export type JournalSqlValueLocation = {
  collection: string
  key: string
  incarnation: number
  path: string[]
}

export type JournalSqlValueReference = { path: string[]; source: JournalSqlValueLocation }
/** The entry's own plain JSON (null when the value is undefined) and the entities it captures. */
export type EncodedJournalSqlValue = { json: string | null; refs: JournalSqlValueReference[] }
export type StoredJournalSqlValue = { data: [] | [unknown]; refs: JournalSqlValueReference[] }

export function journalSqlLocationKey(value: JournalSqlValueLocation): string {
  return JSON.stringify([value.collection, value.key, value.incarnation])
}

/** Captured fields become refs and save as null; every other object is saved inline. */
export function encodeJournalSqlValue(
  value: unknown,
  owner: JournalSqlValueLocation,
  locations: WeakMap<object, JournalSqlValueLocation>,
  /** A bulk import gives each object the first place it was saved, for later captures. */
  place = false
): EncodedJournalSqlValue {
  const refs: JournalSqlValueReference[] = []
  if (value === undefined) {
    return { json: null, refs }
  }
  const captures = journalSqlCapturedPaths(owner.collection)
  const paths = new WeakMap<object, string[]>()
  const json = JSON.stringify(value, function (key, child: unknown) {
    if (typeof child !== 'object' || child === null) {
      return child
    }
    const path = key === '' && !paths.has(this) ? [] : [...(paths.get(this) ?? []), key]
    const source = locations.get(child)
    if (
      source &&
      source.path.length === 0 &&
      captures[path.join('.')] === source.collection &&
      journalSqlLocationKey(source) !== journalSqlLocationKey(owner)
    ) {
      refs.push({ path, source })
      return null
    }
    if (place && !source) {
      locations.set(child, { ...owner, path })
    }
    paths.set(child, path)
    return child
  })
  return { json, refs }
}

/** Reads a saved payload; byte accounting belongs to the caller's scope. */
export function parseJournalSqlValue(
  json: unknown,
  refs: JournalSqlValueReference[],
  parse: (json: string) => unknown = JSON.parse
): StoredJournalSqlValue {
  if (json === null || json === undefined) {
    return { data: [], refs }
  }
  if (typeof json !== 'string') {
    throw new Error('Invalid journal projection value')
  }
  return { data: [parse(json)], refs }
}

export function decodeJournalSqlValue(
  value: StoredJournalSqlValue,
  resolve: (location: JournalSqlValueLocation) => unknown
): unknown {
  let result = value.data[0]
  for (const ref of value.refs) {
    const source = resolve(ref.source)
    if (ref.path.length === 0) {
      result = source
    } else {
      let parent = result
      for (const key of ref.path.slice(0, -1)) {
        parent = readProperty(parent, key)
      }
      if (typeof parent !== 'object' || parent === null) {
        throw new Error('Invalid journal projection reference path')
      }
      Reflect.set(parent, ref.path.at(-1)!, source)
    }
  }
  return result
}

export function readJournalSqlReferencePath(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    value = readProperty(value, key)
  }
  return value
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid journal projection reference path')
  }
  // oxlint-disable-next-line anti-slop/no-reflect-get -- Reference paths must pass through the tracked object's getter to preserve nested writes.
  return Reflect.get(value, key)
}
