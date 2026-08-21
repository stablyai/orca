import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import { syncSystemConfigIntoLegacySharedCodexHome } from '../codex/codex-config-mirror'

type LegacySharedCodexConfigPaths = {
  sharedRuntimeHome: string
  systemCodexHome: string
}

export function syncLegacySharedCodexConfigForRetainedPanes(
  paths?: LegacySharedCodexConfigPaths
): void {
  try {
    const resolvedPaths = paths ?? {
      sharedRuntimeHome: getOrcaManagedCodexHomePath(),
      systemCodexHome: getSystemCodexHomePath()
    }
    syncSystemConfigIntoLegacySharedCodexHome({
      runtimeHomePath: resolvedPaths.sharedRuntimeHome,
      systemHomePath: resolvedPaths.systemCodexHome
    })
  } catch (error) {
    // Why: compatibility for a retained pane must never block real-home Codex.
    console.warn('[codex-runtime-home] Failed to refresh legacy shared config:', error)
  }
}
