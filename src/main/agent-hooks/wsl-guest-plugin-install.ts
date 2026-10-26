import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_INSTALL_PLUGINS_METHOD } from '../../shared/agent-hook-relay'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'
import { selectOpenCodePluginSources } from './opencode-plugin-settings'
import type { ManagedHookDetectionSettings } from './managed-hook-detection-commands'
import type { PluginSources } from '../../wsl-guest/plugin-overlay'

type GuestPluginInstallDeps = {
  pluginSources: () => PluginSources
  managedHookSettings?: () => ManagedHookDetectionSettings
  warn: (message: string) => void
}

/** Only none invalidates cached overlay paths; unavailable preserves them across old guests and teardown. */
export type GuestOverlayResult =
  | { kind: 'dir'; dir?: string; dir2?: string; piDir?: string; ompDir?: string }
  | { kind: 'none' }
  | { kind: 'unavailable' }

export async function requestGuestOpenCodeOverlayDir(
  mux: SshChannelMultiplexer,
  deps: GuestPluginInstallDeps,
  distro: string,
  launchKind?: 'pi' | 'omp'
): Promise<GuestOverlayResult> {
  try {
    const res = await mux.request(AGENT_HOOK_INSTALL_PLUGINS_METHOD, {
      ...selectOpenCodePluginSources(deps.pluginSources(), deps.managedHookSettings?.() ?? null),
      ...(launchKind ? { launchKind } : {})
    })
    const overlayDirs: Record<string, unknown> =
      isRecord(res) && isRecord(res.overlayDirs) ? res.overlayDirs : {}
    const dir = overlayDirs.opencode
    const dir2 = overlayDirs.opencode2
    const piDir = overlayDirs.pi
    const ompDir = overlayDirs.omp
    const opencodeDir = typeof dir === 'string' && dir.length > 0 ? dir : undefined
    const opencode2Dir = typeof dir2 === 'string' && dir2.length > 0 ? dir2 : undefined
    const guestPiDir = typeof piDir === 'string' && piDir.length > 0 ? piDir : undefined
    const guestOmpDir = typeof ompDir === 'string' && ompDir.length > 0 ? ompDir : undefined
    return opencodeDir || opencode2Dir || guestPiDir || guestOmpDir
      ? {
          kind: 'dir',
          ...(opencodeDir ? { dir: opencodeDir } : {}),
          ...(opencode2Dir ? { dir2: opencode2Dir } : {}),
          ...(guestPiDir ? { piDir: guestPiDir } : {}),
          ...(guestOmpDir ? { ompDir: guestOmpDir } : {})
        }
      : { kind: 'none' }
  } catch (err) {
    // Older guests lack the handler (-32601); connection loss and disposal are routine teardown.
    const code = isRecord(err) ? err.code : undefined
    if (code === -32601 || code === 'CONNECTION_LOST' || code === 'DISPOSED' || mux.isDisposed()) {
      return { kind: 'unavailable' }
    }
    deps.warn(
      `[agent-hooks] WSL installPlugins for '${distro}' failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return { kind: 'unavailable' }
  }
}
