import type { CodexConfigSyncStatus } from '../../../../shared/agent-accounts/codex/codex-config-sync-types'

/** A safety check only: the helper always comes from the running install. */
export const CODEX_CONFIG_SYNC_WSL_PROTOCOL = 1

export type CodexConfigSyncWslHomeResult = {
  runtimeHome: string
  complete: boolean
  status: CodexConfigSyncStatus
  error: string | null
  /** The engine's own warnings, which the guest would otherwise lose. */
  warnings: string[]
}

export type CodexConfigSyncWslOutput = {
  protocol: number
  homes: CodexConfigSyncWslHomeResult[]
}
