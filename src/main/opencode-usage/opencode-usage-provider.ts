import type { UsageProvider } from '../usage/provider-lifecycle/usage-provider-contract'
import { scanOpenCodeUsageDatabasesViaWorker } from '../usage/scan-worker/usage-scan-worker-spawn'
import type { OpenCodeUsageDailyAggregate, OpenCodeUsageSession } from './types'

// Invalidate older caches: retain per-session daily identity after migration and token normalization.
export const OPENCODE_USAGE_SCHEMA_VERSION = 8

export const openCodeUsageProvider = {
  id: 'opencode',
  label: 'OpenCode',
  schemaVersion: OPENCODE_USAGE_SCHEMA_VERSION,
  scan: scanOpenCodeUsageDatabasesViaWorker
} satisfies UsageProvider<OpenCodeUsageSession, OpenCodeUsageDailyAggregate>
