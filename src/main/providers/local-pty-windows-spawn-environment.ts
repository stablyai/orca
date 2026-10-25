import { win32 as pathWin32 } from 'node:path'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV
} from '../../shared/claude-profile-routing'
import { ORCA_HERMES_STARTUP_QUERY_ENV } from '../../shared/hermes-startup-query'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from '../pty/codex-home-wsl-env'
import { addWslEnvKeys } from '../wsl-env'
import { parseWslPath } from '../wsl'
import { isWindowsGitBashShellPath } from '../git-bash'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import {
  ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE_ENV,
  resolveWindowsShellLaunchArgs
} from './windows-shell-args'
import type { PtySpawnOptions } from './pty-provider-contract'

export function finalizeWindowsLocalPtySpawnEnvironment(args: {
  spawn: PtySpawnOptions
  plan: LocalPtyLaunchPlan
  env: Record<string, string>
}): void {
  const { spawn, plan, env } = args
  const codexHomeWslInfo = env.CODEX_HOME ? parseWslPath(env.CODEX_HOME) : null
  if (pathWin32.basename(plan.shellPath).toLowerCase() === 'wsl.exe') {
    if (codexHomeWslInfo) {
      if (plan.launchWslDistro && plan.launchWslDistro !== codexHomeWslInfo.distro) {
        delete env.CODEX_HOME
        delete env.ORCA_CODEX_HOME
      } else {
        env.CODEX_HOME = codexHomeWslInfo.linuxPath
        env.ORCA_CODEX_HOME = codexHomeWslInfo.linuxPath
        // wsl.exe imports custom variables only through WSLENV.
        addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
        if (!plan.launchWslDistro) {
          const resolved = resolveWindowsShellLaunchArgs(
            plan.shellPath,
            plan.cwd,
            plan.defaultCwd,
            {
              distro: codexHomeWslInfo.distro
            }
          )
          plan.shellArgs = resolved.shellArgs
          plan.effectiveCwd = resolved.effectiveCwd
          plan.validationCwd = resolved.validationCwd
          plan.startupCommandDeliveredInShellArgs =
            resolved.startupCommandDeliveredInShellArgs === true
        }
      }
    } else if (isHostCodexHomeForWsl(env.CODEX_HOME)) {
      // Host-local CODEX_HOME cannot address WSL Codex; use the guest home.
      delete env.CODEX_HOME
      delete env.ORCA_CODEX_HOME
    } else if (env.CODEX_HOME) {
      addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
    }
    if (env.CLAUDE_CONFIG_DIR) {
      // Managed Claude needs the guest config imported through WSLENV.
      addWslEnvKeys(env, ['CLAUDE_CONFIG_DIR'])
    }
    if (env[CLAUDE_PROFILE_POINTER_ENV]) {
      addWslEnvKeys(env, [CLAUDE_PROFILE_POINTER_ENV, CLAUDE_INJECTED_CONFIG_DIR_ENV])
    }
    if (env[ORCA_HERMES_STARTUP_QUERY_ENV] !== undefined) {
      // Import the custom query variable so the WSL startup wrapper can consume it.
      addWslEnvKeys(env, [ORCA_HERMES_STARTUP_QUERY_ENV])
    }
  } else if (codexHomeWslInfo || isWslCodexHomeForHost(env.CODEX_HOME)) {
    // Windows cannot use guest Codex paths; clear the alias too or shell-ready would restore it.
    delete env.CODEX_HOME
    delete env.ORCA_CODEX_HOME
  }

  const shellBasename = pathWin32.basename(plan.shellPath).toLowerCase()
  const codexLaunchPreflightCommand = env.ORCA_CODEX_LAUNCH_PREFLIGHT
  if (
    codexLaunchPreflightCommand &&
    (shellBasename === 'cmd.exe' || isWindowsGitBashShellPath(plan.shellPath))
  ) {
    if (shellBasename === 'cmd.exe') {
      // node-pty escapes argv quotes; expand the preflight quote inside cmd.exe instead.
      env[ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE_ENV] = '"'
    }
    const resolved = resolveWindowsShellLaunchArgs(
      plan.shellPath,
      plan.cwd,
      plan.defaultCwd,
      plan.launchWslContext,
      spawn.command,
      codexLaunchPreflightCommand
    )
    plan.shellArgs = resolved.shellArgs
    plan.effectiveCwd = resolved.effectiveCwd
    plan.validationCwd = resolved.validationCwd
    plan.startupCommandDeliveredInShellArgs = resolved.startupCommandDeliveredInShellArgs === true
  }
}
