import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanCodexUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import type { CodexUsageDailyAggregate, CodexUsagePersistedFile, CodexUsageSession } from './types'

// Why: v5 keys Codex ownership on raw token_count identity without session id
// so forks that rewrite session_meta still match. Older caches used session-
// scoped keys and can double-count after fork/resume (#8006).
// v6 adds per-request long-context token counts, which older rows cannot be backfilled with.
// v7 persists packed ownership-key digests instead of raw keys, which bloated the cache to 200+ MB.
export const CODEX_USAGE_SCHEMA_VERSION = 7

export const codexUsageProvider = {
  id: 'codex',
  label: 'Codex',
  schemaVersion: CODEX_USAGE_SCHEMA_VERSION,
  scan: scanCodexUsageFilesViaWorker
} satisfies UsageProvider<
  'processedFiles',
  CodexUsagePersistedFile,
  CodexUsageSession,
  CodexUsageDailyAggregate
>
