import {
  applyCodexDaemonOverride,
  codexDaemonSocketPathExceedsLimit
} from '../shared-server/codex-daemon-socket-path-guard'
import {
  applyCodexSharedSqliteHome,
  readCodexSharedSqliteHome
} from '../toml/config-toml-shared-sqlite-home'

/**
 * Values the managed home owns: never mirrored from, or promoted to, the user's own config.
 * The shared sqlite_home line belongs to the history link pass; a mirror only carries it forward.
 */
export function applyRuntimeOwnedConfig(
  config: string,
  runtimeHomePath: string,
  previousConfig: string | null
): string {
  return applyMeasuredRuntimeOwnedConfig(
    config,
    runtimeHomePath,
    previousConfig,
    codexDaemonSocketPathExceedsLimit(runtimeHomePath)
  )
}

/** `applyRuntimeOwnedConfig` for a caller that already measured the home's daemon socket path. */
export function applyMeasuredRuntimeOwnedConfig(
  config: string,
  runtimeHomePath: string,
  previousConfig: string | null,
  daemonSocketPathExceedsLimit: boolean
): string {
  return applyCodexSharedSqliteHome(
    applyCodexDaemonOverride(config, runtimeHomePath, daemonSocketPathExceedsLimit),
    readCodexSharedSqliteHome(previousConfig ?? '')
  )
}
