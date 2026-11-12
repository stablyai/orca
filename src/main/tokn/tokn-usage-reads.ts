import type { ToknSyncRow, ToknTracking } from '../../shared/tokn-sync-status'
import type { ClaudeUsageDailyAggregate } from '../claude-usage/types'
import type { CodexUsageDailyAggregate } from '../codex-usage/types'
import { buildToknSyncRows } from './tokn-sync-rows'

type ToknUsageStore<Aggregate> = {
  getScanState(): { enabled: boolean; lastScanError: string | null }
  refresh(force?: boolean): Promise<unknown>
  getDailyAggregates(): readonly Aggregate[]
}

/** The usage service's loaded stores; tokn reads them where they live. */
export type ToknUsageStores = {
  claude: ToknUsageStore<ClaudeUsageDailyAggregate>
  codex: ToknUsageStore<CodexUsageDailyAggregate>
}

export function readToknTracking(stores: ToknUsageStores): ToknTracking {
  return {
    claude: stores.claude.getScanState().enabled,
    codex: stores.codex.getScanState().enabled
  }
}

async function readAggregates<Aggregate>(
  store: ToknUsageStore<Aggregate>
): Promise<readonly Aggregate[]> {
  if (!store.getScanState().enabled) {
    return []
  }
  // Reuses a scan from the last few minutes; otherwise rescans the local logs.
  await store.refresh(false)
  const scan = store.getScanState()
  // A failed scan keeps the previous totals; uploading them would report a sync that read nothing.
  if (scan.enabled && scan.lastScanError) {
    throw new Error('The last usage scan failed')
  }
  return store.getDailyAggregates()
}

/** Collapses here, so per-project rollups never leave the usage service. */
export async function readToknRows(stores: ToknUsageStores): Promise<ToknSyncRow[]> {
  const [claude, codex] = await Promise.all([
    readAggregates(stores.claude),
    readAggregates(stores.codex)
  ])
  return buildToknSyncRows({ claude, codex })
}
