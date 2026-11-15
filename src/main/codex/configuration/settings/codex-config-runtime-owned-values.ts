import { applyCodexDaemonSocketGuard } from '../shared-server/codex-daemon-socket-path-guard'
import {
  applyCodexSharedSqliteHome,
  readCodexSharedSqliteHome
} from '../toml/config-toml-shared-sqlite-home'
import type { CodexSettingsPromotionHomes } from './config-settings-promotion'

/**
 * Values the managed home owns: never mirrored from, or promoted to, the user's own config.
 * A caller that doesn't know the home's sharing state keeps the shared databases it already had.
 */
export function applyRuntimeOwnedConfig(
  config: string,
  homes: Pick<CodexSettingsPromotionHomes, 'runtimeHomePath' | 'sqliteHome'>,
  previousConfig: string | null
): string {
  return applyCodexSharedSqliteHome(
    applyCodexDaemonSocketGuard(config, homes.runtimeHomePath),
    homes.sqliteHome !== undefined
      ? homes.sqliteHome
      : readCodexSharedSqliteHome(previousConfig ?? '')
  )
}
