import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanOpenCodeUsageDatabases } from './scanner'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession
} from './types'

// Why: v2 adds per-database session ownership (stale sibling-copy dedupe).
// Older caches were built without it and can carry doubled sessions (#8006).
export const OPENCODE_USAGE_SCHEMA_VERSION = 2

export const openCodeUsageProvider = {
  id: 'opencode',
  label: 'OpenCode',
  schemaVersion: OPENCODE_USAGE_SCHEMA_VERSION,
  scan: scanOpenCodeUsageDatabases
} satisfies UsageProvider<
  'processedDatabases',
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession,
  OpenCodeUsageDailyAggregate
>
