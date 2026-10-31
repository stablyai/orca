import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanOpenCodeUsageDatabasesViaWorker } from '../usage/usage-scan-worker-spawn'
import type { OpenCodeUsageDailyAggregate, OpenCodeUsageSession } from './types'

// Invalidate older caches: retain per-session daily identity after migration and token normalization.
export const OPENCODE_USAGE_SCHEMA_VERSION = 8

export const openCodeUsageProvider = {
  id: 'opencode',
  label: 'OpenCode',
  schemaVersion: OPENCODE_USAGE_SCHEMA_VERSION,
  scan: scanOpenCodeUsageDatabasesViaWorker
} satisfies UsageProvider<OpenCodeUsageSession, OpenCodeUsageDailyAggregate>
