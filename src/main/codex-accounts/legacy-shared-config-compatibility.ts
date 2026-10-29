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
    // Retained-pane compatibility failures must not block real-home launches.
    console.warn('[codex-runtime-home] Failed to refresh legacy shared config:', error)
  }
}
