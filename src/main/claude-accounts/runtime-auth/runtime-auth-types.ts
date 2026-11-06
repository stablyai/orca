import type { ClaudeEnvPatch } from '../environment'

export type ClaudeRuntimeAuthPreparation = {
  configDir: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxConfigDir?: string | null
  envPatch: ClaudeEnvPatch
  provenance: string
  /** Report unavailable usage without throwing out the entire polling cycle. */
  usageError?: string
  /** The account pool chose this launch, including when it fell back to the selected account. */
  pooled?: boolean
}
