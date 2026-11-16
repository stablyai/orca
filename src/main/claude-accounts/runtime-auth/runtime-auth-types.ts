import type { ClaudeEnvPatch } from './environment'
import type { UsageReadingAccount } from '../../../shared/agent-usage/rate-limits/rate-limit-types'

export type ClaudeRuntimeAuthPreparation = {
  configDir: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxConfigDir?: string | null
  envPatch: ClaudeEnvPatch
  provenance: string
  /** The account slot whose login this reads (null id: System default, including covered accounts). */
  readingAccount?: UsageReadingAccount
  /** Report unavailable usage without throwing out the entire polling cycle. */
  usageError?: string
}
