// The install pass a connected WSL relay runs inside its guest: the managed
// hook installers, the OpenCode plugin overlay, and the interval policy that
// decides when a still-running relay may install again. Kept out of the
// manager so that file stays about relay lifecycle.
import type { ManagedHookDetectionSettings } from './managed-hook-detection-commands'
import type { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import { requestGuestOpenCodeOverlayDir } from './wsl-guest-plugin-install'
import { installWslGuestHooks } from './wsl-hook-fs-adapter'
import { REINSTALL_MIN_INTERVAL_MS } from './wsl-hook-relay-deps'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PluginSources } from '../../relay/plugin-overlay'

/** Structural slice of WslHookRelayManagerDeps — only what an install pass uses. */
type GuestInstallDeps = {
  installHooks: typeof installRemoteManagedAgentHooks
  managedHookSettings: () => ManagedHookDetectionSettings
  pluginSources: () => PluginSources
  warn: (message: string) => void
}

/** Structural slice of the manager's DistroState this pass reads and writes. */
type GuestInstallState = {
  distro: string
  mux?: SshChannelMultiplexer
  guestHome?: string
  opencodeOverlayDir?: string
  lastInstallAt?: number
}

export async function runWslRelayGuestInstall(
  deps: GuestInstallDeps,
  state: GuestInstallState,
  mux: SshChannelMultiplexer,
  guestHome: string
): Promise<void> {
  state.lastInstallAt = Date.now()
  await installWslGuestHooks({
    mux,
    guestHome,
    distro: state.distro,
    installHooks: deps.installHooks,
    settings: deps.managedHookSettings(),
    warn: deps.warn
  })
  // Why: ship OpenCode's status plugin and record the guest overlay dir the
  // PTY env points OPENCODE_CONFIG_DIR at; identity-guarded against teardown.
  const overlay = await requestGuestOpenCodeOverlayDir(mux, deps, state.distro)
  if (state.mux === mux && overlay.kind !== 'unavailable') {
    // Clearing on 'none' matters: a rebuild that failed after wiping leaves the dir
    // present but plugin-less, and advertising it would hide the user's own config.
    state.opencodeOverlayDir = overlay.kind === 'dir' ? overlay.dir : undefined
  }
}

/** Rate-limited repeat of the (byte-equality idempotent) install pass on a live relay. */
export async function maybeRerunWslRelayGuestInstall(
  deps: GuestInstallDeps,
  state: GuestInstallState
): Promise<void> {
  const mux = state.mux
  const guestHome = state.guestHome
  if (
    !mux ||
    !guestHome ||
    mux.isDisposed() ||
    Date.now() - (state.lastInstallAt ?? 0) < REINSTALL_MIN_INTERVAL_MS
  ) {
    return
  }
  try {
    // Why: the pass also re-ships the plugin source, so a mid-session Orca upgrade refreshes it.
    await runWslRelayGuestInstall(deps, state, mux, guestHome)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    deps.warn(`[agent-hooks] WSL hook reinstall for '${state.distro}' failed: ${detail}`)
  }
}
