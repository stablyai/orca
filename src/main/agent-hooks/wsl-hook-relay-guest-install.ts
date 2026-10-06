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
import { openCodePluginSettingsKey } from './opencode-plugin-settings'
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
  omoAgentDir?: string
  lastInstallAt?: number
  lastOpenCodeSettings?: string
  // Failed attempts throttle retries without claiming the guest accepted those settings.
  lastAttemptOpenCodeSettings?: string
  lastInstallMux?: SshChannelMultiplexer
  launchKinds?: Set<'pi' | 'omp' | 'omo'>
  installation?: Promise<void>
}

function* requestedKinds(state: GuestInstallState): Generator<'pi' | 'omp' | 'omo' | undefined> {
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
  // Publish ownership before an installer can re-enter the ensure path.
  const installation = Promise.resolve().then(() =>
    installGuestHooksAndPlugins(deps, state, mux, guestHome)
  )
  state.installation = installation
  try {
    await installation
  } finally {
    if (state.installation === installation) {
      state.installation = undefined
    }
  }
}

async function installGuestHooksAndPlugins(
  deps: GuestInstallDeps,
  state: GuestInstallState,
  mux: SshChannelMultiplexer,
  guestHome: string
): Promise<void> {
  if (state.mux !== mux || mux.isDisposed()) {
    return
  }
  if (state.lastInstallMux !== mux) {
    state.lastOpenCodeSettings = undefined
  }
  state.lastInstallMux = mux
  state.lastInstallAt = Date.now()
  state.lastAttemptOpenCodeSettings = openCodePluginSettingsKey(deps.managedHookSettings())
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
    if (state.mux !== mux || mux.isDisposed()) {
      return
    }
    const currentSettings = deps.managedHookSettings()
    const settings = currentSettings && {
      ...currentSettings,
      disabledTuiAgents: currentSettings.disabledTuiAgents?.slice()
    }
    const settingsKey = openCodePluginSettingsKey(settings)
    state.lastAttemptOpenCodeSettings = settingsKey
    const overlay = await requestGuestOpenCodeOverlayDir(
      mux,
      { ...deps, managedHookSettings: () => settings },
      state.distro,
      kind
    )
    if (state.mux !== mux || mux.isDisposed()) {
      return
    }
    if (overlay.kind !== 'unavailable') {
      state.lastOpenCodeSettings = settingsKey
      state.opencodeOverlayDir = overlay.kind === 'dir' ? overlay.dir : undefined
      state.opencode2OverlayDir = overlay.kind === 'dir' ? overlay.dir2 : undefined
      if (kind === 'pi') {
        state.piAgentDir = overlay.kind === 'dir' ? overlay.piDir : undefined
      } else if (kind === 'omp') {
        state.ompStatusExtension = overlay.kind === 'dir' ? overlay.ompDir : undefined
      } else if (kind === 'omo') {
        state.omoAgentDir = overlay.kind === 'dir' ? overlay.omoDir : undefined
      }
    }
  }
}

/** Rate-limited repeat of the (byte-equality idempotent) install pass on a live relay. */
export async function maybeRerunWslRelayGuestInstall(
  deps: GuestInstallDeps,
  state: GuestInstallState
): Promise<void> {
  let waited = false
  // Every settled pass can expose newer settings or another waiter's task.
  for (;;) {
    try {
      if (state.installation) {
        waited = true
        await state.installation
        continue
      }
      const mux = state.mux
      const guestHome = state.guestHome
      const settingsKey = openCodePluginSettingsKey(deps.managedHookSettings())
      if (
        !mux ||
        !guestHome ||
        mux.isDisposed() ||
        (state.lastInstallMux === mux &&
          (waited || Date.now() - (state.lastInstallAt ?? 0) < REINSTALL_MIN_INTERVAL_MS) &&
          (state.lastOpenCodeSettings === settingsKey ||
            state.lastAttemptOpenCodeSettings === settingsKey))
      ) {
        return
      }
      waited = true
      await runWslRelayGuestInstall(deps, state, mux, guestHome)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      deps.warn(`[agent-hooks] WSL hook reinstall for '${state.distro}' failed: ${detail}`)
    }
  }
}
