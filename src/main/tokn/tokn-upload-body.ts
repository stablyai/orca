import type { ToknUploadPreview } from '../../shared/tokn-sync-status'
import type { ClaudeUsageDailyAggregate } from '../claude-usage/types'
import type { CodexUsageDailyAggregate } from '../codex-usage/types'
import { buildToknSyncRows } from './tokn-sync-rows'

type ToknUsageSource<Aggregate> = {
  whenLoaded(): Promise<void>
  getScanState(): { enabled: boolean }
  refresh(force?: boolean): Promise<unknown>
  getDailyAggregates(): readonly Aggregate[]
}

export type ToknUsageSources = {
  claude: ToknUsageSource<ClaudeUsageDailyAggregate>
  codex: ToknUsageSource<CodexUsageDailyAggregate>
}

/** Tracking flags are defaults until both stores have read their saved state. */
export async function readToknTracking(
  usage: ToknUsageSources
): Promise<{ claude: boolean; codex: boolean }> {
  await Promise.all([usage.claude.whenLoaded(), usage.codex.whenLoaded()])
  return {
    claude: usage.claude.getScanState().enabled,
    codex: usage.codex.getScanState().enabled
  }
}

async function readAggregates<Aggregate>(
  source: ToknUsageSource<Aggregate>
): Promise<readonly Aggregate[]> {
  await source.whenLoaded()
  if (!source.getScanState().enabled) {
    return []
  }
  // Reuses a scan from the last few minutes; otherwise rescans the local logs.
  await source.refresh(false)
  return source.getDailyAggregates()
}

/** The exact request body, shared by the upload and its preview. */
export async function buildToknUploadBody(
  usage: ToknUsageSources,
  appVersion: string
): Promise<ToknUploadPreview['body']> {
  const [claude, codex] = await Promise.all([
    readAggregates(usage.claude),
    readAggregates(usage.codex)
  ])
  return {
    rows: buildToknSyncRows({ claude, codex }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scannedAt: new Date().toISOString(),
    cliVersion: appVersion
  }
}
