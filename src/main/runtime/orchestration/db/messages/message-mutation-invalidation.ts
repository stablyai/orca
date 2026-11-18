import type { OrchestrationDb } from '../orchestration-db'

export function captureMessageMutation(db: OrchestrationDb, ids: string[]): () => void {
  const read = () => {
    const rows = new Map<string, { address: string; state: string }>()
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500)
      for (const row of db.db
        .prepare(`
        SELECT id, to_handle, read, delivered_at, pointer_enter_pending FROM messages
        WHERE id IN (${batch.map(() => '?').join(',')})
      `)
        .all(...batch)) {
        if (typeof row.id === 'string' && typeof row.to_handle === 'string') {
          rows.set(row.id, { address: row.to_handle, state: JSON.stringify(row) })
        }
      }
    }
    return rows
  }
  const before = read()
  return () => {
    const publish = () => {
      const after = read()
      const addresses = new Set<string>()
      for (const [id, row] of before) {
        if (after.get(id)?.state !== row.state) {
          addresses.add(row.address)
          const next = after.get(id)
          if (next) {
            addresses.add(next.address)
          }
        }
      }
      if (addresses.size) {
        db.crewChanges.notify(
          Object.assign(new Set(['traffic'] as const), { trafficAddresses: addresses })
        )
      }
    }
    // An outer transaction can still roll back; compare committed rows on the next turn.
    if (db.db.isTransaction) {
      queueMicrotask(() => {
        try {
          publish()
        } catch {
          /* The owning database can close after the transaction commits. */
        }
      })
    } else {
      publish()
    }
  }
}
