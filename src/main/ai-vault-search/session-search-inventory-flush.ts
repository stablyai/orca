import type SyncDatabase from '../sqlite/sync-database'
import type {
  SessionSearchPhysicalTable,
  SessionSearchPhysicalMutation,
  SessionSearchPhysicalEpoch
} from './session-search-inventory-page'

export function flushSessionSearchPhysical(
  db: SyncDatabase,
  pending: Map<string, { table: SessionSearchPhysicalTable } & SessionSearchPhysicalMutation>
): void {
  // Group only final independent column patches; masks preserve untouched versus NULL.
  while (pending.size) {
    const first = pending.values().next().value!
    const names = Object.keys(first.fields).sort()
    const signature = names.join(',')
    const rows: SessionSearchPhysicalMutation[] = []
    for (const [key, row] of pending) {
      if (row.table === first.table && Object.keys(row.fields).sort().join(',') === signature) {
        rows.push({ source: row.source, path: row.path, parent: row.parent, fields: row.fields })
        pending.delete(key)
      }
    }
    const payload = JSON.stringify(
      rows.map(({ source, path, parent, fields }) => [
        source,
        path,
        parent,
        ...names.map((name) => fields[name])
      ])
    )
    db.prepare(`INSERT INTO temp.${first.table} (source,path,parent,${signature})
        SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),${names.map((_, index) => `json_extract(value,'$[${index + 3}]')`).join(',')}
        FROM json_each(?) WHERE 1 ON CONFLICT(source,path) DO UPDATE SET ${names.map((name) => `${name}=excluded.${name}`).join(',')}`).run(
      payload
    )
    if (
      rows.some((row) => Object.values(row.fields).some((value) => value === null || value === 0))
    ) {
      const empty =
        first.table === 'search_inventory_entries'
          ? 'file_revision IS NULL AND directory=0'
          : 'authority_self IS NULL AND observation_authority IS NULL AND delivery_revision IS NULL'
      db.prepare(`DELETE FROM temp.${first.table} WHERE (source,path) IN
          (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)) AND ${empty}`).run(
        payload
      )
    }
  }
}

export function flushSessionSearchEpochs(
  db: SyncDatabase,
  epochs: Map<string, SessionSearchPhysicalEpoch>
): void {
  if (epochs.size) {
    const inserted: (string | number | undefined)[][] = [],
      removed: number[][] = []
    for (const row of epochs.values()) {
      if (row.path === undefined) {
        removed.push([row.source, row.revision])
      } else {
        inserted.push([row.source, row.revision, row.path, row.cutoff])
      }
    }
    if (removed.length) {
      db.prepare(`DELETE FROM temp.search_inventory_epochs
        WHERE kind='observation-epochs' AND (source,revision) IN
        (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`).run(
        JSON.stringify(removed)
      )
    }
    if (inserted.length) {
      db.prepare(`INSERT INTO temp.search_inventory_epochs(source,kind,revision,path,cutoff,sealed)
        SELECT json_extract(value,'$[0]'),'observation-epochs',json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),0
        FROM json_each(?) WHERE 1 ON CONFLICT(source,kind,revision) WHERE kind='observation-epochs'
        DO UPDATE SET path=excluded.path,cutoff=excluded.cutoff,sealed=0`).run(
        JSON.stringify(inserted)
      )
    }
    epochs.clear()
  }
}
