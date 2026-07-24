// Ships plugin/extension source to the guest WSL relay and returns the
// OpenCode config-overlay dir it materialized, or null. Best-effort: an older
// guest bundle lacks the handler (-32601) and routine teardown races resolve
// to null so the PTY env drops OPENCODE_CONFIG_DIR (no regression). Mirrors the
// SSH relay's installPluginsOnRelay swallow list.
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_INSTALL_PLUGINS_METHOD } from '../../shared/agent-hook-relay'
import type { PluginSources } from '../../relay/plugin-overlay'

/** Structural, not the deps type itself, so this stays free of the deps module. */
type GuestPluginInstallDeps = {
  pluginSources: () => PluginSources
  warn: (message: string) => void
}

export async function requestGuestOpenCodeOverlayDir(
  mux: SshChannelMultiplexer,
  deps: GuestPluginInstallDeps,
  distro: string
): Promise<string | null> {
  try {
    const res = (await mux.request(AGENT_HOOK_INSTALL_PLUGINS_METHOD, deps.pluginSources())) as {
      overlayDirs?: { opencode?: unknown }
    }
    const dir = res?.overlayDirs?.opencode
    return typeof dir === 'string' && dir.length > 0 ? dir : null
  } catch (err) {
    // Why: -32601 = older guest bundle without the handler; CONNECTION_LOST/DISPOSED = routine mid-flight teardown — swallow both.
    const code = (err as { code?: unknown })?.code
    if (code === -32601 || code === 'CONNECTION_LOST' || code === 'DISPOSED' || mux.isDisposed()) {
      return null
    }
    deps.warn(
      `[agent-hooks] WSL installPlugins for '${distro}' failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}
