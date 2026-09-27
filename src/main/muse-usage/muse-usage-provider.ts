import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanMuseUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import type { MuseUsageDailyAggregate, MuseUsagePersistedFile, MuseUsageSession } from './types'

// v2: event keys carry a per-log ordinal.
export const MUSE_USAGE_SCHEMA_VERSION = 2

export const museUsageProvider = {
  id: 'muse',
  label: 'Muse Code',
  schemaVersion: MUSE_USAGE_SCHEMA_VERSION,
  scan: scanMuseUsageFilesViaWorker
} satisfies UsageProvider<
  'processedFiles',
  MuseUsagePersistedFile,
  MuseUsageSession,
  MuseUsageDailyAggregate
>
