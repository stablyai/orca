// The install pass a connected WSL relay runs inside its guest: the managed
// hook installers, the OpenCode plugin overlay, and the interval policy that
// decides when a still-running relay may install again. Kept out of the
// manager so that file stays about relay lifecycle.
import type { ManagedHookDetectionSettings } from './managed-hook-detection-commands'
import type { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import { requestGuestOpenCodeOverlayDir } from './wsl-guest-plugin-install'
import { installWslGuestHooks } from './wsl-hook-fs-adapter'
import { REINSTALL_MIN_INTERVAL_MS, type WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PluginSources } from '../../relay/plugin-overlay'

/** Structural slice of WslHookRelayManagerDeps — only what an install pass uses. */
type GuestInstallDeps = {
  installHooks: typeof installRemoteManagedAgentHooks
  installCodex: WslHookRelayManagerDeps['installCodex']
  managedHookSettings: () => ManagedHookDetectionSettings
  pluginSources: () => PluginSources
  warn: (message: string) => void
}

/** Structural slice of the manager's DistroState this pass reads and writes. */
type GuestInstallState = {
  distro: string
  mux?: SshChannelMultiplexer
  guestHome?: string
  codexHomePath?: string
  opencodeOverlayDir?: string
  opencode2OverlayDir?: string
  piAgentDir?: string
  ompStatusExtension?: string
  lastInstallAt?: number
  launchKinds?: Set<'pi' | 'omp'>
  installation?: Promise<void>
}

function* requestedKinds(state: GuestInstallState): Generator<'pi' | 'omp' | undefined> {
  if (!state.launchKinds?.size) {
    yield undefined
  }
  if (state.launchKinds) {
    yield* state.launchKinds
  }
}

export async function runWslRelayGuestInstall(
  deps: GuestInstallDeps,
  state: GuestInstallState,
  mux: SshChannelMultiplexer,
  guestHome: string
): Promise<void> {
  if (state.installation) {
    return state.installation
  }
  state.installation = installGuestHooksAndPlugins(deps, state, mux, guestHome)
  try {
    await state.installation
  } finally {
    state.installation = undefined
  }
}

async function installGuestHooksAndPlugins(
  deps: GuestInstallDeps,
  state: GuestInstallState,
  mux: SshChannelMultiplexer,
  guestHome: string
): Promise<void> {
  state.lastInstallAt = Date.now()
  await installWslGuestHooks({
    mux,
    guestHome,
    codexHomePath: state.codexHomePath ?? null,
    distro: state.distro,
    installHooks: deps.installHooks,
    installCodex: deps.installCodex,
    settings: deps.managedHookSettings(),
    warn: deps.warn
  })
  // Why: ship OpenCode's status plugin and record the guest overlay dir the
  // PTY env points OPENCODE_CONFIG_DIR at; identity-guarded against teardown.
  const kinds = requestedKinds(state)
  for (const kind of kinds) {
    const overlay = await requestGuestOpenCodeOverlayDir(mux, deps, state.distro, kind)
    if (state.mux !== mux) {
      return
    }
    if (overlay.kind !== 'unavailable') {
      state.opencodeOverlayDir = overlay.kind === 'dir' ? overlay.dir : undefined
      state.opencode2OverlayDir = overlay.kind === 'dir' ? overlay.dir2 : undefined
      if (kind === 'pi') {
        state.piAgentDir = overlay.kind === 'dir' ? overlay.piDir : undefined
      } else if (kind === 'omp') {
        state.ompStatusExtension = overlay.kind === 'dir' ? overlay.ompDir : undefined
      }
    }
  }
}

/** Rate-limited repeat of the (byte-equality idempotent) install pass on a live relay. */
export async function maybeRerunWslRelayGuestInstall(
  deps: GuestInstallDeps,
  state: GuestInstallState
): Promise<void> {
  if (state.installation) {
    await state.installation
    return
  }
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
