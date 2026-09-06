import { app } from 'electron'
import { classifyError } from '../telemetry/classify-error'
import { track } from '../telemetry/client'
import { getPtyIdForPaneKey } from '../ipc/pty'
import {
  getDaemonProvider,
  initDaemonPtyProvider,
  listLiveDaemonPtyIds
} from '../daemon/daemon-init'
import {
  getCodexPaneAccount,
  hasAnyRecordedLegacyWslCodexPane,
  hasRecordedManagedHostCodexPane,
  isCodexPaneHomeRouteProvenAwayFromSharedHome,
  reconcileCodexPaneAccountsWithLivePtys,
  type CodexPaneHomeRoute
} from '../codex/codex-pane-account-registry'
import { reconcileRetainedCodexHookHomes } from '../codex/retained-codex-hook-state'
import { codexHookService } from '../codex/hook-service'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { agentHookServer } from '../agent-hooks/server'
import {
  indexPersistedPaneKeyPtyIds,
  isLocalExecutionHost,
  resolveAgentWorkspaceExecutionHostId,
  sweepRestoredSubagentsWithoutLiveAgent
} from '../agent-hooks/restored-subagent-liveness-sweep'
import { startFirstWindowStartupServices } from './first-window-startup-services'
import { logStartupMilestone } from './startup-diagnostics'
import type { WindowsDesktopStartupServices } from './windows-desktop-shell-path-startup'
import type { RuntimeWorktreeLifecycleEvent } from '../runtime/orca-runtime'
import { mainProcessState as state } from './main-process-state'

export function emitPluginWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
  state.pluginService?.emitEvent(
    event.kind === 'created' ? 'worktree.created' : 'worktree.removed',
    event.kind === 'created'
      ? { worktreeId: event.worktreeId, path: event.path, branch: event.branch }
      : { worktreeId: event.worktreeId, path: event.path }
  )
}

export function handleCodexHomePtySpawned(args: {
  id: string
  codexHomePath: string | null
  reattached?: boolean
  reattachedHomeRoute?: CodexPaneHomeRoute | null
  launchEnv?: NodeJS.ProcessEnv
  startedAt?: Date
  startedSequence?: number
}): void {
  // Why: only shared or ambiguous retained shells can create rollout logs that still need publication.
  if (args.reattached && args.startedSequence !== undefined) {
    const paneAccount = getCodexPaneAccount(args.id)
    const homeRoute =
      args.reattachedHomeRoute !== undefined
        ? (args.reattachedHomeRoute ?? undefined)
        : paneAccount?.homeRoute
    if (state.codexSessionMigration && isCodexPaneHomeRouteProvenAwayFromSharedHome(homeRoute)) {
      state.codexSessionMigration.ignoreLaunch(args.id, args.startedSequence)
      return
    }
  }
  const fullScanRequired =
    state.codexRuntimeHome?.beginHostSystemDefaultSessionMigrationLaunch(args.codexHomePath, {
      reattached: args.reattached,
      launchEnv: args.launchEnv
    }) ?? null
  if (fullScanRequired !== null) {
    state.codexSessionMigration?.beginLaunch(
      args.id,
      args.reattached === true || fullScanRequired,
      args.startedAt,
      args.startedSequence
    )
  }
}

export function handlePtyExit(id: string, exitSequence: number): void {
  state.codexSessionMigration?.finishLaunch(id, exitSequence)
}

/** A PTY that dies while Orca is down never runs the teardown that clears pane
 *  state, so hydrate can rebuild a Claude subagent roster that no later hook can
 *  retire — pinning the pane 'working' and locking its agent out of hibernation
 *  for good. Once provider and hook hydration settle, targeted PTY liveness can
 *  retire only rows whose local owner is proven gone. */
export async function reapRestoredSubagentsWithoutLiveAgent(): Promise<void> {
  const store = state.store
  if (!store) {
    return
  }
  const provider = getDaemonProvider()
  if (!provider) {
    return
  }
  const persistedPtyIdByPaneKey = indexPersistedPaneKeyPtyIds(
    store.getWorkspaceSession().terminalLayoutsByTabId ?? {}
  )
  await sweepRestoredSubagentsWithoutLiveAgent({
    probeLiveLocalPty: (ptyId) => provider.probePtyLiveness(ptyId),
    isLocalExecutionHost: (worktreeId) =>
      isLocalExecutionHost(
        resolveAgentWorkspaceExecutionHostId(worktreeId, {
          getRepo: (repoId) => store.getRepo(repoId),
          getWorktreeMeta: (resolvedWorktreeId) => store.getWorktreeMeta(resolvedWorktreeId),
          getFolderWorkspace: (folderWorkspaceId) => store.getFolderWorkspace(folderWorkspaceId),
          getProjectGroups: () => store.getProjectGroups()
        })
      ),
    getBoundPtyIdForPaneKey: getPtyIdForPaneKey,
    getPersistedPtyIdForPaneKey: (paneKey) => persistedPtyIdByPaneKey.get(paneKey),
    reap: (isLocalHost, isLocalPaneAgentLive, isLocalPaneLivenessEvidenceCurrent) =>
      agentHookServer.reapRestoredClaudeSubagentsWithoutLiveAgent(
        isLocalHost,
        isLocalPaneAgentLive,
        isLocalPaneLivenessEvidenceCurrent
      )
  })
}

export function startTerminalRuntimeStartupServices(): WindowsDesktopStartupServices {
  logStartupMilestone('first-window-startup-services-start')
  const startupServices = startFirstWindowStartupServices({
    // Why: both desktop and headless serve must adopt the same persistent provider before creating terminals or a renderer.
    startDaemonPtyProvider: async (signal) => {
      logStartupMilestone('startup-service-start', { service: 'daemon-pty-provider' })
      // Why: only GUI-spawned macOS daemons watch for login-session death; a headless
      // serve daemon must survive its spawning session ending (SSH disconnect).
      await initDaemonPtyProvider(signal, {
        macosLoginSessionWatch: process.platform === 'darwin' && !state.isServeMode
      })
      // Why: a retained shell keeps its launch-time Codex home even when the current routing lane changes.
      const hasRetainedManagedHostPane = hasRecordedManagedHostCodexPane()
      if (
        state.codexRuntimeHome &&
        (hasRetainedManagedHostPane || hasAnyRecordedLegacyWslCodexPane())
      ) {
        const livePtyIds = await listLiveDaemonPtyIds()
        if (livePtyIds) {
          reconcileCodexPaneAccountsWithLivePtys(livePtyIds)
          const settings = state.store?.getSettings()
          // Why (#16441): each retained home can run a codex app-server grant
          // session. Awaiting them here delayed the first window by N sessions;
          // a retained shell cannot invoke Codex before this provider serves.
          if (hasRetainedManagedHostPane) {
            void reconcileRetainedCodexHookHomes({
              hookService: codexHookService,
              hooksEnabled:
                isAgentStatusHooksEnabled(settings) &&
                settings?.disabledTuiAgents.includes('codex') !== true,
              runtimeHomePaths: state.codexRuntimeHome.getRetainedHostCodexHookHomePaths(livePtyIds)
            }).catch((error) =>
              console.warn('[codex-hook-service] retained Codex home reconcile failed:', error)
            )
          }
        }
      }
      // Why: retained shells can invoke Codex immediately after the startup gate.
      state.codexRuntimeHome?.reconcileLegacySharedHomeForRetainedPanes()
      logStartupMilestone('startup-service-done', { service: 'daemon-pty-provider' })
    },
    // Why: PTY spawn env reads ORCA_AGENT_HOOK_* from live server state, so the renderer awaits this before restored terminals reconnect.
    startAgentHookServer: async () => {
      const settings = state.store?.getSettings()
      if (!isAgentStatusHooksEnabled(settings)) {
        return
      }
      logStartupMilestone('startup-service-start', { service: 'agent-hook-server' })
      // Why (#11217): the hook listener fails open on every request error, so an IDS resetting
      // loopback POSTs mid-body stops agent status for every runtime with no symptom but staleness.
      // Log + telemetry (the daemon_start_failed pattern) so it is diagnosable without a packet capture.
      agentHookServer.setTransportInterferenceListener((report) => {
        track('agent_hook_transport_blocked', { count: report.count })
      })
      await agentHookServer.start({
        env: app.isPackaged ? 'production' : 'development',
        // Why: hooks source this endpoint file at invocation time so old PTY env reaches the current process after restart; dev namespaces it (worktrees share `orca-dev`).
        userDataPath: app.getPath('userData'),
        endpointNamespace: state.devAgentHookEndpointNamespace
      })
      logStartupMilestone('startup-service-done', { service: 'agent-hook-server' })
    },
    onDaemonError: (error) => {
      // Why: daemon failure silently falls back to non-persistent local PTYs; log + telemetry so a fleet-wide outage is observable (was invisible in v1.4.129-rc.1).
      const reason = error instanceof Error ? error.message : String(error)
      console.error(
        `[daemon] STARTUP FAILED — falling back to local PTYs; terminals will not persist across quit. Reason: ${reason}`
      )
      track('daemon_start_failed', classifyError(error))
    },
    onAgentHookServerError: (error) => {
      // Why: hook callbacks are sidebar enrichment only; Orca must still boot if the loopback receiver fails.
      console.error('[agent-hooks] Failed to start local hook server:', error)
    }
  })
  void startupServices.firstWindowReady.then(() =>
    logStartupMilestone('first-window-startup-services-ready')
  )
  void startupServices.localPtyReady.then(() => {
    logStartupMilestone('local-pty-startup-ready')
    void reapRestoredSubagentsWithoutLiveAgent().catch((error) =>
      console.warn('[agent-hooks] restored-subagent liveness probe failed:', error)
    )
  })
  return startupServices
}

export function bindTerminalRuntimeStartupServices(
  services: Promise<WindowsDesktopStartupServices>
): void {
  state.firstWindowStartupServicesReady = services.then((value) => value.firstWindowReady)
  state.localPtyStartupReady = services.then((value) => value.localPtyReady)
  state.localPtyProviderStartupReady = services.then((value) => value.localPtyProviderReady)
}
