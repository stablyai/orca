import type { UsageProvider } from '../usage/provider-lifecycle/usage-provider-contract'
import { scanMuseUsageFilesViaWorker } from '../usage/scan-worker/usage-scan-worker-spawn'
import type { MuseUsageDailyAggregate, MuseUsageSession } from './types'

// Event-key ordinals require invalidating older caches.
export const MUSE_USAGE_SCHEMA_VERSION = 2

export const museUsageProvider = {
  id: 'muse',
  label: 'Muse Code',
  schemaVersion: MUSE_USAGE_SCHEMA_VERSION,
  scan: scanMuseUsageFilesViaWorker
} satisfies UsageProvider<MuseUsageSession, MuseUsageDailyAggregate>
