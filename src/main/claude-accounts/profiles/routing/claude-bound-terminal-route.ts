import { CLAUDE_PROFILE_POINTER_ENV } from '../../../../shared/agent-accounts/claude/claude-profile-routing'
import { claudeConfigDirEnvPatch } from '../../../claude/structured/launch/claude-config-dir-pin'
import type { ClaudeRuntimeAuthPreparation } from '../../runtime-auth/runtime-auth-types'
import type { ClaudeEnvPatch } from '../../runtime-auth/environment'
import { installedClaudeAccountBinding } from '../../selection/claude-workspace-account-binding'
import type { ClaudeAccountSelectionTarget } from '../../selection/runtime-selection'
import { getClaudeProfileRouter } from './claude-profile-installed-router'

/** A terminal in a project bound to a Claude account: its environment and, for a direct `claude`
 *  launch, the auth preparation that replaces the selection's. */
export type ClaudeBoundTerminalRoute = {
  envPatch: ClaudeEnvPatch
  preparation: ClaudeRuntimeAuthPreparation
}

/** Null leaves the terminal on the selection: no binding, no router, or a WSL lane, whose folders
 *  a host binding cannot name. Never checks the folder: a broken binding must not stop a terminal
 *  opening, and Claude asks to sign in there instead of running another account. */
export function claudeBoundTerminalRoute(
  worktreeId: string | undefined,
  target: ClaudeAccountSelectionTarget | undefined
): ClaudeBoundTerminalRoute | null {
  const binding = installedClaudeAccountBinding(worktreeId)
  const router = getClaudeProfileRouter()
  if (!binding || !router || target?.runtime === 'wsl') {
    return null
  }
  const home =
    binding.kind === 'managed' ? router.accountHome(binding.accountId) : binding.configDir
  if (binding.kind === 'managed') {
    // Why not awaited: setup can take seconds, and the terminal opens either way.
    void router.prepareAccount(binding.accountId).catch((error: unknown) => {
      console.warn('[claude-profile] Could not set up the project Claude account:', error)
    })
  }
  // Why the empty pointer: the `claude` shell function would otherwise re-read the selection.
  const envPatch: ClaudeEnvPatch = {
    [CLAUDE_PROFILE_POINTER_ENV]: '',
    // Why: naming the default folder explicitly changes the CLI's Keychain identity on macOS.
    ...claudeConfigDirEnvPatch(home, { env: { CLAUDE_CONFIG_DIR: router.systemDefaultHome() } })
  }
  return {
    envPatch,
    preparation: {
      configDir: home,
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch,
      provenance: binding.kind === 'managed' ? `profile:${binding.accountId}` : 'system'
    }
  }
}
