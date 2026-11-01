import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanCodexUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import type { CodexUsageDailyAggregate, CodexUsageSession } from './types'

// Rescan older caches for turn-ID fork deduplication and per-session daily identity.
export const CODEX_USAGE_SCHEMA_VERSION = 8

export const codexUsageProvider = {
  id: 'codex',
  label: 'Codex',
  schemaVersion: CODEX_USAGE_SCHEMA_VERSION,
  scan: scanCodexUsageFilesViaWorker
} satisfies UsageProvider<CodexUsageSession, CodexUsageDailyAggregate>
