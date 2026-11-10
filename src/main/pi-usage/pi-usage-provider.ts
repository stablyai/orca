import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanPiUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import type { PiUsageDailyAggregate, PiUsageSession } from './types'

export const PI_USAGE_SCHEMA_VERSION = 1

export const piUsageProvider = {
  id: 'pi',
  label: 'Pi',
  schemaVersion: PI_USAGE_SCHEMA_VERSION,
  scan: scanPiUsageFilesViaWorker
} satisfies UsageProvider<PiUsageSession, PiUsageDailyAggregate>
