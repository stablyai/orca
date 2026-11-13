import { cloudDevSigningAllowed, withCloudBuildDefaults } from '../cloud-build-defaults'
import {
  findCloudRuntimeBySandboxId,
  isAsleepOnControlPlane,
  noteCloudRuntimeRemoteState,
  setCloudAsleepCheck
} from './hosted-remote-sleep'
// Wires Orca Cloud into the desktop when this build has a control plane configured (off by default).
import { app, BrowserWindow, ipcMain } from 'electron'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import {
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled
} from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { readFreshOrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-refresh'
import type { OrcaCloudAvailability, OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'
import type { PluginService } from '../plugins/plugin-service'
import { getHostedSandboxConfig } from './hosted-sandbox-config'
import { createHostedSandboxDeviceEnroller } from './hosted-sandbox-device-enrollment'
import { registerOrcaCloudDeviceEnroller } from '../runtime/rpc/methods/orca-cloud/orca-cloud-device-enrollment'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { registerCloudRemoteDesktopHandlers } from '../ipc/cloud-remote-desktop'
import { readCloudWorkspaceSnapshot } from '../ipc/cloud-workspaces'
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
import { orcaCloudAccountId } from '../../shared/hosted-sandbox/orca-cloud-account'
import { setOrcaCloudActiveAccountResolver } from './orca-cloud-active-account'
import { createCloudAccountBackfill } from './cloud-account-backfill'
import { createCloudSandboxGonePrune } from './cloud-sandbox-gone-prune'
import { setCloudGonePruneRunner } from './cloud-gone-prune-request'
import { retireGoneCloudSandbox } from './cloud-sandbox-gone-retire'
import type { RemovedServerStore } from '../ipc/runtime-environments/runtime-environment-removal-cleanup'
import { createUsageAlertRefreshScheduler } from '../billing/usage-alert-refresh'
import { sendToTrustedUIRenderer } from '../ipc/ui'
import { ORCA_BILLING_REFRESH_CHANNEL } from '../../shared/orca-billing'
import {
  registerOrcaCloudEnvironmentHandlers,
  type OrcaCloudEnvironmentRepoSource
} from '../ipc/cloud-environments/orca-cloud-environment-handlers'
import { installCloudTransferHandlers } from './cloud-transfer'
import { installCloudOfflineService, setCloudOfflineService } from './cloud-offline-service'
import { getCloudSyncService, installCloudSync } from '../cloud-sync/cloud-sync-ipc'
import {
  findCloudRuntime,
  isArchivedOnControlPlane,
  setCloudArchiveCheck
} from './hosted-workspace-runtime'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import type { HostedSessionRestartResult } from '../../shared/hosted-sandbox/hosted-session-events'
import {
  installCloudMcpSync,
  registerCloudMcpSyncHandlers
} from '../agent-mcp-sync/desktop/cloud-mcp-sync-ipc'
import {
  installLocalCommands,
  registerLocalCommandHandlers
} from '../local-commands/local-command-service'
import {
  installCloudAgentConfigSync,
  registerCloudAgentConfigSyncHandlers
} from '../agent-config-sync/desktop/cloud-agent-config-sync-ipc'

/** Capability Orca Cloud auth grants per account (stablyai/orca-cloud#689). */
export const ORCA_CLOUD_SANDBOX_CAPABILITY = 'sandbox'

let installed: { registry: HostedSessionRegistry } | null = null
let controlPlaneClient: HostedSandboxControlPlaneClient | null = null

/** The control plane this build talks to; null when Orca Cloud is not configured. */
export function getHostedSandboxControlPlaneClient(): HostedSandboxControlPlaneClient | null {
  return controlPlaneClient
}

/** `repos` is main's repo store: org-environment repo imports only read checkouts listed there. */
export function installHostedSandbox(
  repos?: OrcaCloudEnvironmentRepoSource & RemovedServerStore
): void {
  // Idempotent; answers isConfigured() = false itself when this build has no control plane.
  registerOrcaCloudEnvironmentHandlers(repos ? { repos } : {})
  if (installed) {
    return
  }
  ipcMain.removeHandler('orcaCloud:restartNow')
  ipcMain.handle('orcaCloud:restartNow', (_event, args: { workspaceId: string }) =>
    restartHostedWorkspace(args.workspaceId)
  )
  registerCloudMcpSyncHandlers()
  registerCloudAgentConfigSyncHandlers()
  const userDataPath = app.getPath('userData')
  registerLocalCommandHandlers()
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
  controlPlaneClient = client
  // The team the sandbox token is minted for; creates are filed under it and lists scope to it.
  const activeAccountId = (): string | null =>
    orcaCloudAccountId(ensureActiveOrcaProfile(userDataPath).profile.cloud)
  setOrcaCloudActiveAccountResolver(activeAccountId)
  const gonePrune = createCloudSandboxGonePrune({
    userDataPath,
    activeAccountId,
    get: (sandboxId) => client.get(sandboxId),
    retire: (runtime) => retireGoneCloudSandbox(userDataPath, repos, runtime)
  })
  const accountBackfill = createCloudAccountBackfill({
    userDataPath,
    activeAccountId,
    list: () => client.list(),
    onListed: (account, listed) => gonePrune.observeList(account, listed),
    relistMs: 10 * 60_000
  })
  // A cloud list refresh or a not-found status read asks for the prune now (LC-2).
  setCloudGonePruneRunner(() => accountBackfill.run({ force: true }))
  installLocalCommands(userDataPath)
  const mcpSync = installCloudMcpSync(userDataPath, {
    baseUrl: config.controlPlaneUrl,
    getAccessToken: config.getAccessToken
  })
  const agentConfigSync = installCloudAgentConfigSync(userDataPath)
  // Dev rehearsals shorten idle sleep; packaged builds always use the provider's default.
  const idleOverride = app.isPackaged
    ? Number.NaN
    : Number(process.env.ORCA_CLOUD_SANDBOX_IDLE_STOP_MS)
  // One mutable capabilities object: the control plane's idle minutes replace the fallback as soon
  // as any status read reports them (dev overrides still win).
  const capabilities = {
    ...base.capabilities,
    idleStopMs: Number.isFinite(idleOverride) ? idleOverride : base.capabilities.idleStopMs
  }
  const driver = { ...base, capabilities }
  const noteIdleSleepMinutes = (minutes: number): void => {
    if (!Number.isFinite(idleOverride)) {
      capabilities.idleStopMs = minutes * 60_000
    }
  }
  // Usage alerts fire on billing reads; re-read on create/wake and every 30 min while one runs
  // (the poll rides the 30 s beat below via registry.sync). Only the main window is asked, so
  // extra windows never stack reads.
  const usageRefresh = createUsageAlertRefreshScheduler({
    requestRefresh: () => sendToTrustedUIRenderer(ORCA_BILLING_REFRESH_CHANNEL, null)
  })
  const registry = createHostedSessionRegistry({
    userDataPath,
    driver,
    windows: () => BrowserWindow.getAllWindows(),
    // Create and wake both connect: MCP servers, skills and commands follow this computer's.
    onConnected: (runtimeEnvironmentId) => {
      void mcpSync.sync(runtimeEnvironmentId, 'connect')
      void agentConfigSync.sync(runtimeEnvironmentId, 'connect')
      getCloudSyncService()?.noteConnected(runtimeEnvironmentId)
    },
    onRunningChange: (anyRunning) => usageRefresh.setRunning(anyRunning),
    activeAccountId
  })
  // Filing first, so a sandbox that just joined the active team gets its scheduler in this pass.
  const syncSessions = (): Promise<void> => accountBackfill.run().finally(() => registry.sync())
  const workspaces = installHostedWorkspaceService({
    userDataPath,
    // Every status read also carries the control plane's idle-sleep minutes.
    client: {
      ...client,
      workspaceStatus: async (sandboxId, signal) => {
        // Asleep there but recorded running here: slept from another client (hosted-remote-sleep).
        const seen = findCloudRuntimeBySandboxId(userDataPath, sandboxId)
        const answer = await client.workspaceStatus(sandboxId, signal)
        if (answer.status.idleSleepMinutes) {
          noteIdleSleepMinutes(answer.status.idleSleepMinutes)
        }
        if (seen) {
          noteCloudRuntimeRemoteState(
            { userDataPath, syncSessions: () => void registry.sync() },
            seen,
            answer.status.state
          )
        }
        return answer
      }
    },
    windows: () => BrowserWindow.getAllWindows(),
    syncSessions: () => void registry.sync(),
    stopSession: (environmentId) => registry.stopEnvironment(environmentId),
    activeAccountId
  })
  setHostedWorkspaceService(workspaces)
  const disposeTransfer = installCloudTransferHandlers({
    userDataPath,
    windows: () => BrowserWindow.getAllWindows()
  })
  setCloudArchiveCheck((workspaceId) => isArchivedOnControlPlane(userDataPath, client, workspaceId))
  setCloudAsleepCheck((workspaceId) => isAsleepOnControlPlane(userDataPath, client, workspaceId))
  const offline = installCloudOfflineService({
    userDataPath,
    call: (environmentId, method, params, timeoutMs) =>
      callRuntimeEnvironment(userDataPath, environmentId, method, params, timeoutMs),
    windows: () => BrowserWindow.getAllWindows(),
    isArchived: async (workspaceId) => {
      const found = findCloudRuntime(userDataPath, workspaceId)
      return found
        ? (await client.workspaceStatus(found.sandboxId)).status.state === 'archived'
        : false
    },
    readCloudSnapshot: async (workspaceId) => {
      const found = findCloudRuntime(userDataPath, workspaceId)
      const read = found ? await readCloudWorkspaceSnapshot(found.sandboxId) : null
      return read?.state === 'ready' ? read.snapshot : null
    }
  })
  setCloudOfflineService(offline)
  installCloudSync(userDataPath)
  // Records land after the step answers and wakes can come from any path, so reconcile on a slow beat too.
  let beat: ReturnType<typeof setTimeout> | null = null
  let beats = 0
  const schedule = (ms: number): void => {
    beat = setTimeout(() => {
      // OOM in the guest is checked every other beat (~1 min) for running cloud workspaces.
      const oom = beats++ % 2 === 1 ? workspaces.pollOom() : Promise.resolve()
      void Promise.all([syncSessions(), oom]).finally(() => schedule(30_000))
    }, ms)
    beat.unref?.()
  }
  registerHostedSandboxRecipe(driver, {
    onReady: () => {
      setTimeout(() => void registry.sync(), 3_000).unref?.()
      // Created or woken: hours may have accrued since the last read (other members, earlier runs).
      usageRefresh.noteStarted()
    },
    onStopped: (environmentId) => registry.stopEnvironment(environmentId),
    onWake: (event) =>
      workspaces.emitWakeProgress({
        ...event,
        // Later phases inherit the source recorded at `waking`.
        source: event.phase === 'waking' ? workspaces.takeWakeSource(event.workspaceId) : 'open'
      })
  })
  installed = { registry }
  registerCloudRemoteDesktopHandlers(client)
  registerOrcaCloudDeviceEnroller(createHostedSandboxDeviceEnroller(config))
  // Also the team-switch nudge: the old team's schedulers stop and the new team's records file.
  setHostedSessionSync(() => void syncSessions())
  schedule(0)
  app.once('will-quit', () => {
    if (beat) {
      clearTimeout(beat)
    }
    registry.dispose()
    usageRefresh.dispose()
    workspaces.dispose()
    disposeTransfer()
    setHostedWorkspaceService(null)
    setCloudArchiveCheck(null)
    setCloudAsleepCheck(null)
    setOrcaCloudActiveAccountResolver(null)
    offline.dispose()
    setCloudOfflineService(null)
  })
}

/** "Restart now" from the window's session-cap toast. */
export function restartHostedWorkspace(workspaceId: string): Promise<HostedSessionRestartResult> {
  return installed
    ? installed.registry.restartWorkspace(workspaceId)
    : Promise.resolve({ status: 'not-running' })
}

/**
 * Orca Cloud auth's `sandbox` capability rolls it out per account; the dev key bypasses it in dev
 * builds. Builds without a hosted-sandbox control plane never offer it, signed in or not.
 */
export async function getOrcaCloudAvailability(): Promise<OrcaCloudAvailability> {
  if (!installed) {
    return 'unavailable'
  }
  const devSigning =
    cloudDevSigningAllowed(app.isPackaged) && Boolean(process.env.ORCA_CLOUD_SANDBOX_DEV_KEY_FILE)
  const auth = getOrcaCloudAuthConfig(process.env, app.isPackaged)
  const canSignIn = auth.configured || isOrcaCloudDevAuthEnabled(process.env, app.isPackaged)
  if (!devSigning && !auth.configured) {
    return 'unavailable'
  }
  const userDataPath = app.getPath('userData')
  const active = ensureActiveOrcaProfile(userDataPath)
  // The dev key signs as the signed-in user, so it skips the capability check but not sign-in.
  if (!active.profile.cloud) {
    return canSignIn ? 'needs-sign-in' : 'unavailable'
  }
  if (devSigning || !auth.configured) {
    return devSigning ? 'offered' : 'unavailable'
  }
  const session = await readFreshOrcaCloudSession(auth.config, active, userDataPath).catch(
    () => null
  )
  // A refresh that failed (offline) is not a sign-out: keep Orca Cloud visible but disabled
  // (Run on says it can't be reached) rather than ask to sign in or make it vanish.
  if (session === null) {
    return 'unreachable'
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
