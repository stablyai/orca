import { setMigrationUnsupportedPty } from '../../../agent-hooks/observations/migration-unsupported-pty-state'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { registerPersistedPaneKeyAlias } from '../../restoring-sessions/pane-alias-normalization'
import type { normalizePersistedPaneIdentityState } from '../../restoring-sessions/workspace-pane-normalization'
import type { ProfileStateStartupPaneAlias } from '../profile-writing/profile-state-authority'

export function registerLoadedPaneIdentity(
  normalized: ReturnType<typeof normalizePersistedPaneIdentityState>,
  unboundPaneAliases: readonly ProfileStateStartupPaneAlias[]
): void {
  for (const entry of unboundPaneAliases) {
    agentHookServer.registerPaneKeyAlias(
      entry.legacyPaneKey,
      entry.stablePaneKey,
      undefined,
      entry.updatedAt
    )
  }
  for (const entry of normalized.migrationUnsupportedEntries) {
    setMigrationUnsupportedPty(entry)
  }
  for (const entry of normalized.legacyPaneKeyAliasEntries) {
    registerPersistedPaneKeyAlias(entry)
  }
}
