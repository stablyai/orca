import {
  provisionClaudeAccountProfile,
  type ClaudeProfileSetupReport
} from './claude-profile-setup'
import { wslClaudeProfile } from './claude-profile-wsl-paths'

/**
 * Sets up or refreshes a WSL account's folder from the guest user's own Claude state, run as Linux
 * inside the distro: by the bundled helper for the desktop, and by a WSL host's orcad in-process.
 * Hooks are not installed here: they reach the account through the settings copy from ~/.claude.
 */
export function provisionWslClaudeAccountProfile(
  userHome: string,
  distro: string,
  accountId: string
): Promise<ClaudeProfileSetupReport> {
  const { dataRoot, profile } = wslClaudeProfile(userHome, distro, accountId)
  return provisionClaudeAccountProfile({ dataRoot, profile, userHome, installHooks: null })
}
