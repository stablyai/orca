import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanOpenCodeUsageDatabasesViaWorker } from '../usage/usage-scan-worker-spawn'
import type { OpenCodeUsageDailyAggregate, OpenCodeUsageSession } from './types'

// Invalidate older caches: merge migrated rows per column, normalize input and preserve cache writes.
export const OPENCODE_USAGE_SCHEMA_VERSION = 7

export const openCodeUsageProvider = {
  id: 'opencode',
  label: 'OpenCode',
  schemaVersion: OPENCODE_USAGE_SCHEMA_VERSION,
  scan: scanOpenCodeUsageDatabasesViaWorker
} satisfies UsageProvider<OpenCodeUsageSession, OpenCodeUsageDailyAggregate>
