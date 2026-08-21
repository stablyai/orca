import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { CodexConfigSyncStatus } from '../../shared/codex-config-sync-types'
import type { GrokAccountStatus } from '../../shared/rate-limit-types'

export type CodexAccountsApi = {
  list: () => Promise<CodexRateLimitAccountsState>
  add: (args?: {
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }) => Promise<CodexRateLimitAccountsState>
  reauthenticate: (args: {
    accountId: string
    /** Local-only: activate the re-authed account when its runtime lane had no selection. */
    activateIfSelectionWasEmpty?: boolean
  }) => Promise<CodexRateLimitAccountsState>
  remove: (args: { accountId: string }) => Promise<CodexRateLimitAccountsState>
  select: (args: {
    accountId: string | null
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }) => Promise<CodexRateLimitAccountsState>
  /** Live PTYs whose baked CODEX_HOME still points at a deselected account. */
  listStalePanes: (args: { ptyIds: string[] }) => Promise<
    {
      ptyId: string
      launchAccountId: string | null
      activeAccountId: string | null
      /** Optional for compatibility with a pre-reason main process. */
      reason?: 'account-change' | 'home-route-change'
    }[]
  >
  /** The selection lane each PTY launched from, keyed by pty id; unrecorded panes are absent. */
  listRecordedPaneLanes: (args: { ptyIds: string[] }) => Promise<Record<string, string>>
  /** Drops launch records so a dismissed prompt stays dismissed across restarts. */
  forgetStalePanes: (args: { ptyIds: string[] }) => Promise<void>
}

export type ClaudeAccountsApi = {
  list: () => Promise<ClaudeRateLimitAccountsState>
  add: (args?: {
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }) => Promise<ClaudeRateLimitAccountsState>
  cancelPendingLogin: () => Promise<boolean>
  reauthenticate: (args: { accountId: string }) => Promise<ClaudeRateLimitAccountsState>
  remove: (args: { accountId: string }) => Promise<ClaudeRateLimitAccountsState>
  select: (args: {
    accountId: string | null
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }) => Promise<ClaudeRateLimitAccountsState>
}

export type GrokAccountsApi = {
  getStatus: () => Promise<GrokAccountStatus>
}

export type MinimaxCredentialsApi = {
  getStatus: () => Promise<{ configured: boolean }>
  saveCookie: (cookie: string) => Promise<{ configured: boolean }>
  clearCookie: () => Promise<{ configured: boolean }>
}

export type CodexConfigSyncApi = {
  status: () => Promise<CodexConfigSyncStatus>
}
