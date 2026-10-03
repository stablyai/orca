import { getCodexHookFlagTablePath } from '../../../codex/codex-hook-flag-table'
import { scheduleCodexHookFlagSync } from '../../../codex/codex-hook-flag-sync'
import { ORCA_CODEX_HOOK_FLAGS_ENV } from '../../../../shared/codex-shell-function'
import type { BuildPtyHostEnvOptions } from './types'

/**
 * Points a native pane's codex function at Orca's flag table, which each launch
 * reads. Set whatever the settings say: the table is absent while Codex hooks
 * are off, and the pointer stays valid across Orca restarts, so a pane the
 * daemon keeps follows every later change. WSL guests run a Linux Codex whose
 * hash this process never asked for, and keep their installed hooks.
 */
export function applyCodexHookSessionFlagEnv(
  baseEnv: Record<string, string>,
  opts: BuildPtyHostEnvOptions
): void {
  if (opts.isWsl) {
    delete baseEnv[ORCA_CODEX_HOOK_FLAGS_ENV]
    return
  }
  baseEnv[ORCA_CODEX_HOOK_FLAGS_ENV] = getCodexHookFlagTablePath()
  // Why each spawn: serves a request the file watch missed, and a codex installed or updated meanwhile.
  scheduleCodexHookFlagSync()
}
