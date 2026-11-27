import type { UsageProvider } from '../usage/provider-lifecycle/usage-provider-contract'
import { scanAntigravityUsageFilesViaWorker } from '../usage/scan-worker/usage-scan-worker-spawn'
import type { AntigravityUsageDailyAggregate, AntigravityUsageSession } from './types'

export const ANTIGRAVITY_USAGE_SCHEMA_VERSION = 1

export const antigravityUsageProvider = {
  id: 'antigravity',
  label: 'Antigravity',
  schemaVersion: ANTIGRAVITY_USAGE_SCHEMA_VERSION,
  scan: scanAntigravityUsageFilesViaWorker
} satisfies UsageProvider<AntigravityUsageSession, AntigravityUsageDailyAggregate>
