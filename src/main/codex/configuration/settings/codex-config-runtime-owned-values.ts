import { applyCodexDaemonSocketGuard } from '../shared-server/codex-daemon-socket-path-guard'
import { applyCodexSharedSqliteHome } from '../toml/config-toml-shared-sqlite-home'
import type { CodexSettingsPromotionHomes } from './config-settings-promotion'

/** Values the managed home owns: never mirrored from, or promoted to, the user's own config. */
export function applyRuntimeOwnedConfig(
  config: string,
  homes: Pick<CodexSettingsPromotionHomes, 'runtimeHomePath' | 'sqliteHome'>
): string {
  return applyCodexSharedSqliteHome(
    applyCodexDaemonSocketGuard(config, homes.runtimeHomePath),
    homes.sqliteHome
  )
}
