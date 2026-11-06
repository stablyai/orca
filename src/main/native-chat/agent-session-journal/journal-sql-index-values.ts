import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlValueContext } from './journal-sql-value-context'
import type { JournalSqlValueLocation } from './journal-sql-value-codec'

export function journalSqlIndexScope(context: JournalSqlValueContext): JournalSqlScope {
  return context.scope.withIndexValues({
    encode: (value, name, key) => {
      const collection = `@index:${name}`
      context.write(collection, JSON.stringify(key), value)
      const row = context.header(collection, JSON.stringify(key))!
      return JSON.stringify({
        collection,
        key: JSON.stringify(key),
        incarnation: Number(row.incarnation),
        path: []
      })
    },
    decode: <T>(json: string): T => {
      const location: JournalSqlValueLocation = JSON.parse(json)
      const value = context.readReference(location)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: index procedures decode the typed values they captured in their own collection.
      return value as T
    },
    forget: (name, key) => {
      const collection = `@index:${name}`
      if (key === undefined) {
        context.clear(collection)
      } else {
        context.delete(collection, JSON.stringify(key))
      }
    }
  })
}
