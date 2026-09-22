import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanDevinUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import type { DevinUsageDailyAggregate, DevinUsagePersistedFile, DevinUsageSession } from './types'

export const DEVIN_USAGE_SCHEMA_VERSION = 1

export const devinUsageProvider = {
  id: 'devin',
  label: 'Devin',
  schemaVersion: DEVIN_USAGE_SCHEMA_VERSION,
  scan: scanDevinUsageFilesViaWorker
} satisfies UsageProvider<
  'processedFiles',
  DevinUsagePersistedFile,
  DevinUsageSession,
  DevinUsageDailyAggregate
>
