import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanCodexUsageFiles } from './scanner'
import type { CodexUsageDailyAggregate, CodexUsagePersistedFile, CodexUsageSession } from './types'

// Why: v6 keys Codex event ownership on root thread identity + token usage tuples
// without raw timestamp. Codex rewrites copied token_count timestamps to the fork
// creation time, so timestamp-based keys bypassed deduplication on session forks (#19139).
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
