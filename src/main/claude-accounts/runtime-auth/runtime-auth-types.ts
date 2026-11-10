import type { ClaudeEnvPatch } from '../environment'

export type ClaudeRuntimeAuthPreparation = {
  configDir: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxConfigDir?: string | null
  envPatch: ClaudeEnvPatch
  /** Set only by a `--account` launch on a host account that is not the selected one. */
  pinnedAccountId?: string
  provenance: string
  /** Report unavailable usage without throwing out the entire polling cycle. */
  usageError?: string
}

export type ClaudeLaunchAuthOptions = {
  /** A managed host account the launch must run on, whether or not it is the selected one. */
  accountId?: string
}
