import type { GlobalSettings } from '../../shared/global-settings-types'
import { getSelectedClaudeAccountIdForTarget } from '../claude-accounts/runtime-selection'

export type ClaudeManagedAccountGateSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
>

/**
 * A structured Claude session launches against the ambient Claude config, which the account service
 * keeps in sync with the selected HOST account. A WSL-bound managed account lives inside the distro
 * and is never synced there, so such a session would authenticate as whatever the ambient identity
 * happens to be while the UI names the WSL account — the user is told one identity and given
 * another. Refuse the structured path there and let the terminal-backed one, which resolves the
 * account per runtime, handle that account shape.
 *
 * Reads the selection through the same accessor the auth policy uses. Resolving it any other way
 * lets the two disagree, and a session admitted by this gate would then run under a policy computed
 * from a different account than the one approved here.
 *
 * Unknown answers refuse, and only genuinely unknown ones: settings that cannot be read at all, or
 * an active selection this cannot resolve. An install with no managed accounts — the list empty or
 * never written — claims no identity and is fine.
 */
export function structuredClaudeMatchesActiveManagedAccount(
  settings: ClaudeManagedAccountGateSettings | null | undefined
): boolean {
  if (!settings) {
    return false
  }
  // Absent is the same answer as empty — this user has no managed Claude accounts, so nothing
  // claims an identity and ambient auth is the truth. Only settings that cannot be READ are
  // unknown, and those refuse above. The auth policy reads the list the same way.
  const accounts = settings.claudeManagedAccounts ?? []
  if (accounts.length === 0) {
    return true
  }
  const activeHostId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  if (!activeHostId) {
    // Nothing selected for the host runtime is two different states that the settings cannot tell
    // apart after the fact: honest deselection, where ambient auth is the truth and the UI names no
    // identity, and the WSL-only case, where the prune emptied the host slot and persisted null
    // while the UI still names the WSL account. The presence of any WSL-bound account decides.
    return !accounts.some((candidate) => candidate.managedAuthRuntime === 'wsl')
  }
  const active = accounts.find((candidate) => candidate.id === activeHostId)
  return active ? active.managedAuthRuntime !== 'wsl' : false
}

/** Reads the gate's settings, answering null when they cannot be read so callers refuse. */
export function readClaudeManagedAccountGateSettings(
  getSettings: () => ClaudeManagedAccountGateSettings
): ClaudeManagedAccountGateSettings | null {
  try {
    return getSettings()
  } catch {
    return null
  }
}
