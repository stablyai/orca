import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanCodexUsageFiles } from './scanner'
import type { CodexUsageDailyAggregate, CodexUsagePersistedFile, CodexUsageSession } from './types'

// Why: v5 keys Codex ownership on raw token_count identity without session id
// so forks that rewrite session_meta still match. Older caches used session-
// scoped keys and can double-count after fork/resume (#8006).
export const CODEX_USAGE_SCHEMA_VERSION = 5

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
