import { win32 as pathWin32 } from 'node:path'
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
import type { PtySpawnOptions } from './types'

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
        // Why: wsl.exe only imports non-default env vars named in WSLENV.
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
      // Why: Orca's Codex home is host-local; WSL Codex must use its Linux-side ~/.codex, not a Windows path.
      delete env.CODEX_HOME
      delete env.ORCA_CODEX_HOME
    } else if (env.CODEX_HOME) {
      addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
    }
    if (env.CLAUDE_CONFIG_DIR) {
      // Why: managed WSL Claude passes a Linux CLAUDE_CONFIG_DIR through wsl.exe; non-default vars need WSLENV import.
      addWslEnvKeys(env, ['CLAUDE_CONFIG_DIR'])
    }
    if (env[ORCA_HERMES_STARTUP_QUERY_ENV] !== undefined) {
      // Why: wsl.exe drops custom Windows env vars; the startup wrapper needs this imported inside WSL.
      addWslEnvKeys(env, [ORCA_HERMES_STARTUP_QUERY_ENV])
    }
  } else if (codexHomeWslInfo || isWslCodexHomeForHost(env.CODEX_HOME)) {
    // Why: WSL Codex homes are Linux paths Windows can't use; also drop ORCA_CODEX_HOME (shell-ready restores CODEX_HOME from it).
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
      // Why: node-pty backslash-escapes argv quotes; expand the quote inside cmd.exe instead.
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
