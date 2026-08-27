import type { UsageProvider } from '../usage/usage-provider-contract'
import { scanGeminiUsageFiles } from './scanner'
import type {
  GeminiUsageDailyAggregate,
  GeminiUsagePersistedFile,
  GeminiUsageSession
} from './types'

export const GEMINI_USAGE_SCHEMA_VERSION = 1

export const geminiUsageProvider = {
  id: 'gemini',
  label: 'Gemini',
  schemaVersion: GEMINI_USAGE_SCHEMA_VERSION,
  scan: scanGeminiUsageFiles
} satisfies UsageProvider<
  'processedFiles',
  GeminiUsagePersistedFile,
  GeminiUsageSession,
  GeminiUsageDailyAggregate
>
