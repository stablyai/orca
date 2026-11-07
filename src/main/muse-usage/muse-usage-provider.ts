import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanMuseUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import type { MuseUsageDailyAggregate, MuseUsageSession } from './types'

// Event-key ordinals require invalidating older caches.
// Retain session identity in daily rows for period-correct drilldowns.
export const MUSE_USAGE_SCHEMA_VERSION = 3

export const museUsageProvider = {
  id: 'muse',
  label: 'Muse Code',
  schemaVersion: MUSE_USAGE_SCHEMA_VERSION,
  scan: scanMuseUsageFilesViaWorker
} satisfies UsageProvider<MuseUsageSession, MuseUsageDailyAggregate>
