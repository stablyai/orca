import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanCodexUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import type { CodexUsageDailyAggregate, CodexUsageSession } from './types'

// Rescan older caches: v5 deduplicates forks across sessions; v6 adds per-request long-context counts.
export const CODEX_USAGE_SCHEMA_VERSION = 6

export const codexUsageProvider = {
  id: 'codex',
  label: 'Codex',
  schemaVersion: CODEX_USAGE_SCHEMA_VERSION,
  scan: scanCodexUsageFilesViaWorker
} satisfies UsageProvider<CodexUsageSession, CodexUsageDailyAggregate>
