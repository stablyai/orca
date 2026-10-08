import type { ClaudeEnvPatch } from '../environment'

export type ClaudeRuntimeAuthPreparation = {
  configDir: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxConfigDir?: string | null
  envPatch: ClaudeEnvPatch
  stripAuthEnv: boolean
  /** Set only by a `--account` launch on a host account that is not the selected one. */
  pinnedAccountId?: string
  provenance: string
  /** Usage only: why the selected account cannot be read; usage polling must not throw for it. */
  usageError?: string
}

export type ClaudeLaunchAuthOptions = {
  /** A managed host account the launch must run on, whether or not it is the selected one. */
  accountId?: string
}
