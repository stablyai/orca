import { cloudDevSigningAllowed, withCloudBuildDefaults } from '../cloud-build-defaults'
// Wires Orca Cloud into the desktop when this build has a control plane configured (off by default).
import { app, BrowserWindow } from 'electron'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { readFreshOrcaCloudSession } from '../orca-profiles/profile-cloud-session-refresh'
import type { OrcaCloudAvailability, OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'
import type { PluginService } from '../plugins/plugin-service'
import { getHostedSandboxConfig } from './hosted-sandbox-config'
import { createHostedSandboxDeviceEnroller } from './hosted-sandbox-device-enrollment'
import { registerOrcaCloudDeviceEnroller } from '../runtime/rpc/methods/orca-cloud/orca-cloud-device-enrollment'
import {
  ORCA_CLOUD_RECIPE,
  createHostedSandboxRecipeClient,
  createHostedSandboxRecipeDriver,
  registerHostedSandboxRecipe
} from './hosted-sandbox-recipe'
import {
  installHostedWorkspaceService,
  setHostedWorkspaceService
} from './hosted-workspace-service'
import { createHostedSessionRegistry, type HostedSessionRegistry } from './hosted-session-registry'
import { registerCloudShareHandlers } from './hosted-sandbox-share-ipc'
import { setHostedSessionSync } from './hosted-session-sync'

/** Capability Orca Cloud auth grants per account (stablyai/orca-cloud#689). */
export const ORCA_CLOUD_SANDBOX_CAPABILITY = 'sandbox'

let installed: { registry: HostedSessionRegistry } | null = null

export function installHostedSandbox(): void {
  if (installed) {
    return
  }
  const userDataPath = app.getPath('userData')
  const config = getHostedSandboxConfig(
    userDataPath,
    withCloudBuildDefaults(process.env),
    app.isPackaged
  )
  registerCloudShareHandlers(userDataPath, config)
  if (!config) {
    return
  }
  const client = createHostedSandboxRecipeClient(config)
  const base = createHostedSandboxRecipeDriver(config, client)
  // Dev rehearsals shorten idle sleep; packaged builds always use the provider's default.
  const idleOverride = app.isPackaged
    ? Number.NaN
    : Number(process.env.ORCA_CLOUD_SANDBOX_IDLE_STOP_MS)
  const driver = Number.isFinite(idleOverride)
    ? { ...base, capabilities: { ...base.capabilities, idleStopMs: idleOverride } }
    : base
  const registry = createHostedSessionRegistry({
    userDataPath,
    driver,
    windows: () => BrowserWindow.getAllWindows()
  })
  const workspaces = installHostedWorkspaceService({
    userDataPath,
    client,
    windows: () => BrowserWindow.getAllWindows(),
    syncSessions: () => void registry.sync(),
    stopSession: (environmentId) => registry.stopEnvironment(environmentId)
  })
  setHostedWorkspaceService(workspaces)
  // Records land after the step answers and wakes can come from any path, so reconcile on a slow beat too.
  let beat: ReturnType<typeof setTimeout> | null = null
  let beats = 0
  const schedule = (ms: number): void => {
    beat = setTimeout(() => {
      // OOM in the guest is checked every other beat (~1 min) for running cloud workspaces.
      const oom = beats++ % 2 === 1 ? workspaces.pollOom() : Promise.resolve()
      void Promise.all([registry.sync(), oom]).finally(() => schedule(30_000))
    }, ms)
    beat.unref?.()
  }
  registerHostedSandboxRecipe(driver, {
    onReady: () => setTimeout(() => void registry.sync(), 3_000).unref?.(),
    onStopped: (environmentId) => registry.stopEnvironment(environmentId),
    onWake: ({ workspaceId, phase, startedAt, message }) =>
      workspaces.emitWakeProgress({
        workspaceId,
        phase,
        startedAt,
        message,
        // Later phases inherit the source recorded at `waking`.
        source: phase === 'waking' ? workspaces.takeWakeSource(workspaceId) : 'open'
      })
  })
  installed = { registry }
  registerOrcaCloudDeviceEnroller(createHostedSandboxDeviceEnroller(config))
  setHostedSessionSync(() => void registry.sync())
  schedule(0)
  app.once('will-quit', () => {
    if (beat) {
      clearTimeout(beat)
    }
    registry.dispose()
    workspaces.dispose()
    setHostedWorkspaceService(null)
  })
}

/**
 * Orca Cloud auth's `sandbox` capability rolls it out per account; the dev key bypasses it in dev
 * builds. Builds without a hosted-sandbox control plane never offer it, signed in or not.
 */
export async function getOrcaCloudAvailability(): Promise<OrcaCloudAvailability> {
  if (!installed) {
    return 'unavailable'
  }
  if (cloudDevSigningAllowed(app.isPackaged) && process.env.ORCA_CLOUD_SANDBOX_DEV_KEY_FILE) {
    return 'offered'
  }
  const auth = getOrcaCloudAuthConfig(process.env, app.isPackaged)
  if (!auth.configured) {
    return 'unavailable'
  }
  const userDataPath = app.getPath('userData')
  const active = ensureActiveOrcaProfile(userDataPath)
  if (!active.profile.cloud) {
    return 'needs-sign-in'
  }
  const session = await readFreshOrcaCloudSession(auth.config, active, userDataPath).catch(
    () => null
  )
  // A refresh that failed (offline) is not a sign-out; hide the row rather than ask to sign in.
  if (session === null) {
    return 'unavailable'
  }
  if (session.status !== 'found') {
    return 'needs-sign-in'
  }
  return session.session.capabilities.flags[ORCA_CLOUD_SANDBOX_CAPABILITY] === true
    ? 'offered'
    : 'needs-capability'
}

/** Built-in providers (Orca Cloud) ride along with approved plugin recipes and lead every list. */
export async function withProviderRecipes(
  pluginService?: PluginService,
  availability?: OrcaCloudAvailability
): Promise<OrcaVmRecipe[]> {
  const orcaCloud = availability ?? (await getOrcaCloudAvailability())
  return [
    ...(orcaCloud === 'offered' ? [ORCA_CLOUD_RECIPE] : []),
    ...(await getApprovedPluginVmRecipes(pluginService))
  ]
}
