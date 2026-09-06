import { app } from 'electron'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getLocalPtyProvider, getSshPtyProvider, clearProviderPtyState } from '../ipc/pty'
import { agentHookServer } from '../agent-hooks/server'
import { browserManager } from '../browser/browser-manager'
import { loadAgentSessionClaimSigner } from '../runtime/agent-session-claim-identity'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { prepareCodexAiVaultSessionResume } from '../codex/codex-ai-vault-session-resume'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { getDaemonProvider } from '../daemon/daemon-init'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { OrchestrationEnvironmentTransport } from '../runtime/orchestration/environment-transport'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { fingerprintOrchestrationPeer } from '../runtime/orchestration/environment-transport'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { mainProcessState as state } from './main-process-state'
import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'
import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'
import { ArtifactCloudService } from '../artifacts/artifact-cloud-service'
import { SkillCloudService } from '../skills/skill-cloud-service'
import { isArtifactSharingEnabled } from '../../shared/artifact-sharing-gate'

export function getDesktopWindowStatus(): RuntimeDesktopWindowStatus {
  const activation = state.desktopActivationGate
  if (!activation) {
    return 'available'
  }
  const value = activation.getState()
  return value === 'ready' ? 'openable' : value
}

export function initializeMainProcessRuntime(): OrcaRuntimeService {
  const store = state.store
  const stats = state.stats
  if (!store || !stats) {
    throw new Error('Store and stats must be initialized before runtime')
  }
  const orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport = {
    resolve: (selector) => {
      const environment = resolveEnvironment(app.getPath('userData'), selector)
      const pairing = getPreferredPairingOffer(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        peerFingerprint: fingerprintOrchestrationPeer(pairing.publicKeyB64)
      }
    },
    call: (selector, method, params, timeoutMs, envelope) =>
      callRuntimeEnvironment(
        app.getPath('userData'),
        selector,
        method,
        params,
        timeoutMs,
        undefined,
        envelope
      )
  }
  const runtime = new OrcaRuntimeService(store, stats, {
    agentSessionClaimSigner: loadAgentSessionClaimSigner(
      getProfileUserDataPath(),
      getProfileUserDataPath()
    ),
    // Why: resolve the PTY provider lazily — a daemon swap happens later, so an eager reference would freeze the pre-daemon provider (design §4.3).
    getLocalProvider: () => getLocalPtyProvider(),
    // Why: SSH relay providers register after construction and may reconnect, so destructive cleanup must resolve the current generation.
    getSshProvider: (connectionId) => getSshPtyProvider(connectionId),
    onPtyStopped: clearProviderPtyState,
    onTerminalAgentStatus: (event) => agentHookServer.ingestTerminalStatus(event),
    // Why: serve can be promoted in place, so wire the listener from startup; runtime enables desktop-only scanners only for a ready renderer.
    onTerminalSideEffects: (batch: TerminalSideEffectBatch) => {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('pty:sideEffect', batch)
      }
    },
    getDesktopWindowStatus,
    // Why: worktree.ps pulls hook-reported agent status (same source as the desktop sidebar) at query time so mobile shows the same agents.
    getAgentStatusSnapshot: () =>
      agentHookServer.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    // Why: the filter above hides resume-identity rows from the live-agent views, but
    // those rows carry the provider session mobile native chat addresses transcripts
    // by — Pi publishes identity that way and would otherwise be unreachable.
    getAgentProviderSessionSnapshot: () => agentHookServer.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) =>
      agentHookServer.getStatusSnapshotForPane(paneKey),
    attestAgentHookCompatibilityAuthority: (candidate) =>
      agentHookServer.attestCompatibilityAuthority(candidate),
    retireAgentHookCompatibilityAuthority: (paneKey) =>
      agentHookServer.retirePaneAuthority(paneKey),
    reconcileAgentStatusForEndedProcess: (paneKeys) =>
      agentHookServer.reconcileEndedProcessForPaneKeys(paneKeys),
    canRecoverPersistentLocalPtys: () => getDaemonProvider() !== null,
    // Why: evaluated per call, not captured — the RPC server that owns the device registry is
    // constructed with this runtime and does not exist yet at this point.
    getPairedDeviceName: (pairedDeviceId) =>
      state.runtimeRpc?.getDeviceRegistry()?.getDevice(pairedDeviceId)?.name ?? null,
    // Why: source codex-home here (runs in window AND serve) so aiVault.listSessions includes managed-Codex sessions; registerCoreHandlers is window-only.
    getAdditionalAiVaultCodexHomePaths: () =>
      state.codexRuntimeHome?.getHostCodexHomePathsForSessionDiscovery() ?? [],
    prepareAiVaultSessionResume: (args) =>
      prepareCodexAiVaultSessionResume(args, {
        runtimeHome: state.codexRuntimeHome,
        systemCodexHomePath: resolveHostCodexSessionSourceHome(store.getSettings())
      }),
    prepareCodexStructuredLaunch: ({ workspacePath, launchEnv }) =>
      prepareCodexRuntimeHomeForLaunch(undefined, launchEnv, {
        launchAgent: 'codex',
        workspacePath
      }),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(state.store?.getSettings()) ? agentHookServer.buildPtyEnv() : {},
    orchestrationEnvironmentTransport,
    skillTransactionRecovery: state.skillTransactionRecovery
  })
  state.runtime = runtime
  runtime.prepareLegacyWorkerTerminalRecovery()
  // Why before anything can attach: a client host that reattaches to a restarted runtime is only
  // handed its pages back if the runtime found them first.
  runtime.rehydrateClientHostedBrowserPages()
  state.publishProviderSessionChanges?.(agentHookServer.getProviderSessionIdentities())
  browserManager.setBrowserGuestStateChangedListener((worktreeId) => {
    runtime.notifyMobileSessionTabsChanged(worktreeId)
  })
  return runtime
}

export function configureRuntimeServices(runtime: OrcaRuntimeService): void {
  const store = state.store
  const claudeAccounts = state.claudeAccounts
  const codexAccounts = state.codexAccounts
  const rateLimits = state.rateLimits
  if (!store || !claudeAccounts || !codexAccounts || !rateLimits) {
    throw new Error('Account services must be initialized before runtime wiring')
  }
  runtime.setArtifactService(
    new ArtifactCloudService(app.getPath('userData'), () =>
      isArtifactSharingEnabled(state.store?.getSettings())
    )
  )
  runtime.setSkillCloudService(new SkillCloudService(app.getPath('userData')))
  runtime.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  runtime.setCommitMessageAgentEnvironmentResolvers({
    // Why: Codex hooks/auth live in Orca's managed runtime home even for the default path, so every launch must resolve CODEX_HOME via runtime-home.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: (target) => state.claudeRuntimeAuth!.prepareForClaudeLaunch(target)
  })
}
