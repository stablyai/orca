import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'

// Generate anonymous install identity once during migration; every launch reuses the persisted value.

export function generateInstallId(): string {
  return randomUUID()
}

// Read only: missing migrated identity signals startup ordering, and silent regeneration would conceal it.
export function readInstallId(store: Store): string | undefined {
  return store.getSettings().telemetry?.installId
}
