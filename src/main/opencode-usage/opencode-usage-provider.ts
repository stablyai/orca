import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanOpenCodeUsageDatabasesViaWorker } from '../usage/usage-scan-worker-spawn'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession
} from './types'

// Why: v3 includes cache-read tokens in totals; older caches undercount usage.
export const OPENCODE_USAGE_SCHEMA_VERSION = 3

export const openCodeUsageProvider = {
  id: 'opencode',
  label: 'OpenCode',
  schemaVersion: OPENCODE_USAGE_SCHEMA_VERSION,
  scan: scanOpenCodeUsageDatabasesViaWorker
} satisfies UsageProvider<
  'processedDatabases',
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession,
  OpenCodeUsageDailyAggregate
>
