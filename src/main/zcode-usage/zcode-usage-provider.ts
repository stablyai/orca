import type { UsageProvider } from '../usage/provider-lifecycle/usage-provider-contract'
import { scanZcodeUsageDatabasesViaWorker } from '../usage/scan-worker/usage-scan-worker-spawn'
import type { ZcodeUsageDailyAggregate, ZcodeUsageSession } from './types'

// v1: the initial projection over `model_usage` rows.
export const ZCODE_USAGE_SCHEMA_VERSION = 1

export const zcodeUsageProvider = {
  id: 'zcode',
  label: 'ZCode',
  schemaVersion: ZCODE_USAGE_SCHEMA_VERSION,
  scan: scanZcodeUsageDatabasesViaWorker
} satisfies UsageProvider<ZcodeUsageSession, ZcodeUsageDailyAggregate>
