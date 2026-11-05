import { join } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import { writeFileAtomicallyIfUnchanged } from '../../../codex-accounts/fs-utils'
import { getSystemCodexHomePath } from '../homes/codex-home-paths'
import { applyCodexDaemonSocketGuard } from '../shared-server/codex-daemon-socket-path-guard'
import { applyDesktopCuaReplBrowserSurfaceOverride } from '../toml/config-toml-desktop-cua-repl-browser-surface'
import type { CodexSettingsPromotionHomes } from './config-settings-promotion'

// Mirrored MCP environment tokens require owner-only writes.
export const RUNTIME_CONFIG_WRITE = { mode: 0o600 } as const

export function ensureCodexRuntimeConfigOverrides(runtimeHomePath: string): void {
  ensureRuntimeConfigOverridesForHomes({
    runtimeHomePath,
    systemHomePath: getSystemCodexHomePath()
  })
}

export function ensureRuntimeConfigOverridesForHomes(homes: CodexSettingsPromotionHomes): void {
  try {
    const observation = observeAgentStateFile(join(homes.runtimeHomePath, 'config.toml'))
    if (observation.kind !== 'indeterminate') {
      writeRuntimeConfigOverrides(homes, observation.kind === 'present' ? observation.value : null)
    }
  } catch (error) {
    console.warn('[codex-config] Failed to apply Orca runtime config overrides:', error)
  }
}

export function applyRuntimeConfigOverrides(
  config: string,
  homes: CodexSettingsPromotionHomes
): string {
  return applyDesktopCuaReplBrowserSurfaceOverride(
    applyCodexDaemonSocketGuard(config, homes.runtimeHomePath),
    homes
  )
}

export function writeRuntimeConfigOverrides(
  homes: CodexSettingsPromotionHomes,
  runtimeConfig: string | null
): void {
  const overridden = applyRuntimeConfigOverrides(runtimeConfig ?? '', homes)
  if (overridden !== (runtimeConfig ?? '')) {
    writeFileAtomicallyIfUnchanged(
      join(homes.runtimeHomePath, 'config.toml'),
      runtimeConfig,
      overridden,
      RUNTIME_CONFIG_WRITE
    )
  }
}
