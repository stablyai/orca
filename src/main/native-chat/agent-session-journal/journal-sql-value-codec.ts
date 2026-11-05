export type JournalSqlValueLocation = {
  collection: string
  key: string
  incarnation: number
  path: string[]
}

export type JournalSqlValueReference = { path: string[]; source: JournalSqlValueLocation }
export type EncodedJournalSqlValue = { json: string; refs: JournalSqlValueReference[] }
type StoredValue = { data: [] | [unknown]; refs: JournalSqlValueReference[] }

export function journalSqlLocationKey(value: JournalSqlValueLocation): string {
  return JSON.stringify([value.collection, value.key, value.incarnation])
}

export function encodeJournalSqlValue(
  value: unknown,
  owner: JournalSqlValueLocation,
  locate: (value: object) => JournalSqlValueLocation | undefined
): EncodedJournalSqlValue {
  const refs: JournalSqlValueReference[] = []
  const paths = new WeakMap<object, string[]>()
  const stored: StoredValue = { data: value === undefined ? [] : [value], refs }
  paths.set(stored.data, [])
  const json = JSON.stringify(stored, function (key, child: unknown) {
    if (key === '' || this === stored || !paths.has(this)) {
      return child
    }
    if (typeof child !== 'object' || child === null) {
      return child
    }
    const path = this === stored.data ? [] : [...paths.get(this)!, key]
    const source = locate(child)
    if (source && journalSqlLocationKey(source) !== journalSqlLocationKey(owner)) {
      refs.push({ path, source })
      return null
    }
    paths.set(child, path)
    return child
  })
  return { json, refs }
}

export function decodeJournalSqlValue(
  value: StoredValue,
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
