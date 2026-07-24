// Guest-side handler for AGENT_HOOK_INSTALL_PLUGINS_METHOD: caches the plugin
// source the Windows host ships over the wire and materializes OpenCode's
// config overlay inside the guest. Extracted from the relay entrypoint so it is
// unit-testable without binding the hook server. Scope is OpenCode only for
// now; the payload/response shape matches the SSH relay so Pi/OMP are additive.
import type { PluginOverlayManager } from './plugin-overlay'
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

export function handleInstallPlugins(
  pluginOverlay: PluginOverlayManager,
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): InstallPluginsResult {
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
    const sourceDir = resolveOpenCodeSourceConfigDir(env as Record<string, string>, env.SHELL)
    const overlayId = sanitizeWslHookInstanceKey(env[WSL_HOOK_RELAY_INSTANCE_ENV]) ?? 'wsl-opencode'
    // Why: null on write failure — caller falls back to the guest's own config (no status), never crossing a Windows overlay into WSL.
    opencodeDir = pluginOverlay.materializeOpenCode(overlayId, sourceDir) ?? undefined
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
