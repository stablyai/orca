import type { SqlRow } from './database.js'

type Identity = { userId: string; relayHostId: string }
type RowIndex = Map<string, Map<string, SqlRow[]>>

/** A single locked inventory, never retained across transactions or refreshed queries. */
export function createDrainMigrationRowLookup(
  rows: SqlRow[],
  readText: (row: SqlRow, field: string) => string
): {
  first: (identity: Identity) => SqlRow | undefined
  all: (identity: Identity) => SqlRow[]
} {
  let index: RowIndex | null | undefined
  const indexed = (identity: Identity): SqlRow[] | undefined => {
    if (index === undefined) {
      index = indexRows(rows)
    }
    return index?.get(identity.userId)?.get(identity.relayHostId)
  }
  const matches = (row: SqlRow, identity: Identity): boolean =>
    readText(row, 'user_id') === identity.userId &&
    readText(row, 'relay_host_id') === identity.relayHostId
  return {
    first(identity) {
      const group = indexed(identity)
      return index === null ? rows.find((row) => matches(row, identity)) : group?.[0]
    },
    all(identity) {
      const group = indexed(identity)
      return index === null ? rows.filter((row) => matches(row, identity)) : (group ?? [])
    }
  }
}

function indexRows(rows: SqlRow[]): RowIndex | null {
  const index: RowIndex = new Map()
  for (const row of rows) {
    const userId = row.user_id
    const hostId = row.relay_host_id
    // Preserve the original lazy validation and refusal order for malformed database rows.
    if (typeof userId !== 'string' || typeof hostId !== 'string') {
      return null
    }
    let hosts = index.get(userId)
    if (!hosts) {
      hosts = new Map()
      index.set(userId, hosts)
    }
    const group = hosts.get(hostId)
    if (group) {
      group.push(row)
    } else {
      hosts.set(hostId, [row])
    }
  }
  return index
}
