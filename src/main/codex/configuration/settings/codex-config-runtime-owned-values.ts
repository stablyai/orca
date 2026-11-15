import { applyCodexDaemonSocketGuard } from '../shared-server/codex-daemon-socket-path-guard'
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
  return applyCodexSharedSqliteHome(
    applyCodexDaemonSocketGuard(config, runtimeHomePath),
    readCodexSharedSqliteHome(previousConfig ?? '')
  )
}
