// Guest-side handler for AGENT_HOOK_INSTALL_PLUGINS_METHOD: caches the plugin
// source the Windows host ships over the wire and materializes OpenCode's
// config overlay inside the guest. Extracted from the relay entrypoint so it is
// unit-testable without binding the hook server. Scope is OpenCode only for
// now; the payload/response shape matches the SSH relay so Pi/OMP are additive.
import { existsSync } from 'node:fs'

import { getRelayOpenCodePluginPath, type PluginOverlayManager } from './plugin-overlay'
import { resolveOpenCodeSourceConfigDir } from './plugin-overlay-env'
import { assertPluginSourceUnderByteCap } from './plugin-source-limit'
import {
  sanitizeWslHookInstanceKey,
  WSL_HOOK_RELAY_INSTANCE_ENV
} from '../shared/wsl-hook-relay-contract'

export type InstallPluginsResult = {
  installed: { opencode: boolean; pi: boolean; omp: boolean }
  overlayDirs: { opencode?: string }
}

export type InstallPluginsHandler = (params: Record<string, unknown>) => InstallPluginsResult

// Why NOT to fall back to ~/.config/opencode here: OpenCode APPENDS
// OPENCODE_CONFIG_DIR to its config-dir list, it does not replace it — the
// XDG default is always read too. Mirroring the default into the overlay would
// load the user's config (and plugins) twice. Only an explicitly-set dir is
// mirrored, because that one leaves the list when we override the var.
export function createInstallPluginsHandler(
  pluginOverlay: PluginOverlayManager,
  env: NodeJS.ProcessEnv
): InstallPluginsHandler {
  // Why: materializeOpenCode wipes and rebuilds the overlay, and the id here is
  // instance-scoped (not pane-scoped as on SSH). The host re-ships on every
  // reinstall — 60s after connect and again on later pane spawns — so
  // re-materializing unconditionally would delete the config root out from
  // under running agents and race panes spawning against the path the host just
  // handed them. Rebuild only when the shipped source actually changed.
  let materialized: { source: string; sourceDir: string | undefined; dir: string } | null = null

  return (params) => {
    const opencode = params.opencodePluginSource
    const pi = params.piExtensionSource
    const omp = params.ompExtensionSource
    // Why: bound per-source bytes so a buggy/hostile host can't OOM the guest relay.
    assertPluginSourceUnderByteCap('opencodePluginSource', opencode)
    assertPluginSourceUnderByteCap('piExtensionSource', pi)
    assertPluginSourceUnderByteCap('ompExtensionSource', omp)
    pluginOverlay.setSources({
      opencodePluginSource: typeof opencode === 'string' ? opencode : undefined,
      piExtensionSource: typeof pi === 'string' ? pi : undefined,
      ompExtensionSource: typeof omp === 'string' ? omp : undefined
    })
    let opencodeDir: string | undefined
    if (pluginOverlay.hasOpenCodeSource()) {
      // An omitted source leaves the manager's cache untouched, so it counts as unchanged.
      const incoming = typeof opencode === 'string' ? opencode : null
      // Explicit-only (see header). Constant in practice for a relay's lifetime, so
      // keying the cache on it is defensive; the rc scan behind it is memoized.
      const sourceDir = resolveOpenCodeSourceConfigDir(env as Record<string, string>, env.SHELL)
      const cached = materialized
      if (
        cached &&
        (incoming === null || incoming === cached.source) &&
        sourceDir === cached.sourceDir &&
        // Why: the dir surviving a failed rebuild proves nothing — the plugin does.
        existsSync(getRelayOpenCodePluginPath(cached.dir))
      ) {
        opencodeDir = cached.dir
      } else {
        const overlayId =
          sanitizeWslHookInstanceKey(env[WSL_HOOK_RELAY_INSTANCE_ENV]) ?? 'wsl-opencode'
        // Why: null on write failure — caller falls back to the guest's own config (no status), never crossing a Windows overlay into WSL.
        opencodeDir = pluginOverlay.materializeOpenCode(overlayId, sourceDir) ?? undefined
        materialized =
          opencodeDir && incoming !== null
            ? { source: incoming, sourceDir, dir: opencodeDir }
            : null
      }
    }
    return {
      installed: {
        opencode: pluginOverlay.hasOpenCodeSource(),
        pi: pluginOverlay.hasPiSource('pi'),
        omp: pluginOverlay.hasPiSource('omp')
      },
      overlayDirs: opencodeDir ? { opencode: opencodeDir } : {}
    }
  }
}
