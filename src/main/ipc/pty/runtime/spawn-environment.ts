// Removes inherited credential and ownership variables before any runtime PTY provider spawns.
import { getAppEnvironment } from '../../../../shared/app-environment'
import { getLegacyOpenCodeEnvKeysToDelete } from '../../../opencode/legacy-shared-config-dir'
import { CODEX_HOME_ENV_KEYS } from '../host-env/codex-home'
import { CLAUDE_AUTH_ENV_VARS } from '../../../claude-accounts/environment'
import { CLAUDE_PROFILE_PROVIDER_ENV_VARS } from '../../../claude-accounts/claude-profile-environment'
import { LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS } from '../../../pty/legacy-terminal-shim-dir'
import { PI_PROCESS_OWNER_ENV_KEYS } from '../../../pty/pi-process-owner-env'
import {
  mergePtyEnvDeletions,
  removeCodexHomeDeletionRequests,
  getInheritedAgentHookEnvKeysToDelete,
  getInheritedAgentSessionStampEnvKeysToDelete
} from '../host-env/pi-agent'
import { deleteRequestedEnvKeys } from '../host-env/path'
import type { RuntimePtySpawnState } from './spawn-state'

export function applyRuntimePtySpawnEnvironment(ctx: RuntimePtySpawnState): void {
  const args = ctx.args
  const authEnvToDelete = ctx.claudeAuth?.stripAuthEnv
    ? [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS']
    : undefined
  ctx.spawnOptions.envToDelete = mergePtyEnvDeletions(
    authEnvToDelete,
    ctx.claudeAuth?.isolatedCredentials ? CLAUDE_PROFILE_PROVIDER_ENV_VARS : [],
    ctx.agentProfile?.envToDelete ?? [],
    args.envToDelete ?? [],
    // Persistent daemons and older SSH hosts must not resurrect a parent Pi's ownership.
    PI_PROCESS_OWNER_ENV_KEYS,
    // Why: disable old hosts without removing ORCA_REAL_* while their Windows shim remains on PATH.
    ctx.isDaemonHostSpawn || args.connectionId ? LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS : [],
    ctx.isDaemonHostSpawn ? getInheritedAgentHookEnvKeysToDelete(ctx.env) : [],
    // The daemon must judge its own inherited value; main may have a different config.
    !args.connectionId && !ctx.isDaemonHostSpawn
      ? getLegacyOpenCodeEnvKeysToDelete(ctx.env, getAppEnvironment().getPath('userData'))
      : [],
    // Why: ungated, unlike the agent-hook keys — the local provider and the relay host also spread their own process.env into every spawn.
    getInheritedAgentSessionStampEnvKeysToDelete(ctx.env),
    ctx.skipCodexHomeEnv ? CODEX_HOME_ENV_KEYS : [],
    // Why: the daemon owns a persistent inherited environment that may
    // differ from main. ORCA_CODEX_HOME asks it to compare/delete the pair.
    ctx.stripInheritedOrcaCodexHome ? ['ORCA_CODEX_HOME'] : []
  )
  if (ctx.codexResumeHomeSelected) {
    ctx.spawnOptions.envToDelete = removeCodexHomeDeletionRequests(ctx.spawnOptions.envToDelete)
  }
  deleteRequestedEnvKeys(ctx.env, ctx.spawnOptions.envToDelete)
}
