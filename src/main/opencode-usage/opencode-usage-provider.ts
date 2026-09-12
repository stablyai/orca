import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanOpenCodeUsageDatabases } from './scanner'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession
} from './types'

// Why: v2 added per-database session ownership (stale sibling-copy dedupe, #8006);
// v3 counts cache.read + cache.write in input, so v2 snapshots under-count
// OpenCode tokens and are rebuilt.
export const OPENCODE_USAGE_SCHEMA_VERSION = 3

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
