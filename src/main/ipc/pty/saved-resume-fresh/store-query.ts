import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SAVED_RESTORE_ROOT_KEYS } from '../../../../shared/saved-restore-dispatch'

export type SavedRestoreRoots = Partial<Record<(typeof SAVED_RESTORE_ROOT_KEYS)[number], string>>

export type SavedResumeStoreQuery = {
  agent: string
  providerSession: AgentProviderSessionMetadata
  /** Reported by the invocation itself; no root is inferred from Orca's own launch state. */
  roots: SavedRestoreRoots
  cwd: string | undefined
  recipeArgs: string
  settings:
    | Pick<GlobalSettings, 'codexShareHistoryAcrossAccounts' | 'codexManagedAccounts'>
    | undefined
}

/** The invocation's home folder, or null when it reported none. */
export function reportedHome(roots: SavedRestoreRoots): string | null {
  return (process.platform === 'win32' ? roots.USERPROFILE : roots.HOME)?.trim() || null
}
