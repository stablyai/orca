import type { UsageProvider } from '../usage/provider-lifecycle/usage-provider-contract'
import { scanMistralVibeUsageFilesViaWorker } from '../usage/scan-worker/usage-scan-worker-spawn'
import type { MistralVibeUsageDailyAggregate, MistralVibeUsageSession } from './types'

export const MISTRAL_VIBE_USAGE_SCHEMA_VERSION = 1

export const mistralVibeUsageProvider = {
  id: 'mistral-vibe',
  label: 'Mistral Vibe',
  schemaVersion: MISTRAL_VIBE_USAGE_SCHEMA_VERSION,
  scan: scanMistralVibeUsageFilesViaWorker
} satisfies UsageProvider<MistralVibeUsageSession, MistralVibeUsageDailyAggregate>
