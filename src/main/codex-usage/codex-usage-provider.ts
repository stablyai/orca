import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanCodexUsageFiles } from './scanner'
import type { CodexUsageDailyAggregate, CodexUsagePersistedFile, CodexUsageSession } from './types'

// Why: v6 snapshots the originating Codex account on session and daily
// projections. Older caches have no account dimension, so they must be
// rescanned rather than silently serving unfilterable combined totals.
export const CODEX_USAGE_SCHEMA_VERSION = 6

export const codexUsageProvider = {
  id: 'codex',
  label: 'Codex',
  schemaVersion: CODEX_USAGE_SCHEMA_VERSION,
  scan: scanCodexUsageFiles
} satisfies UsageProvider<
  'processedFiles',
  CodexUsagePersistedFile,
  CodexUsageSession,
  CodexUsageDailyAggregate
>
