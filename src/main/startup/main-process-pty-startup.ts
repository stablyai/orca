import { app } from 'electron'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { isLocalExecutionHost } from '../../shared/execution-host'
import { classifyError } from '../telemetry/classify-error'
import { track } from '../telemetry/client'
import { getPtyIdForPaneKey } from '../ipc/pty/pane/key-state'
import { getDaemonProvider, listLiveDaemonPtyIds } from '../daemon/daemon-provider-state'
import { initDaemonPtyProvider } from '../daemon/daemon-provider-init'
import { restartLocalTerminalsAfterElevation } from '../windows/windows-administrator-restart'
import { resolveTerminalSpawnAdmissionMode } from '../daemon/terminal-spawn-gate'
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
import {
  isAgentStatusHooksEnabled,
  isAgentStatusHooksEnabledForAgent
} from '../agent-hooks/managed-agent-hook-controls'
import { agentHookServer } from '../agent-hooks/server'
import { createLocalTmuxManagedPtyResolver } from '../agent-hooks/local-tmux-managed-pty'
import {
  indexPersistedPaneKeyPtyIds,
  resolveAgentWorkspaceExecutionHostId,
  retireRestoredStatusesWithDeadTerminals
} from '../agent-hooks/restored-status-dead-terminal-sweep'
import { startFirstWindowStartupServices } from './first-window-startup-services'
import { logStartupMilestone } from './startup-diagnostics'
import type { WindowsDesktopStartupServices } from './windows-desktop-shell-path-startup'
import type { RuntimeWorktreeLifecycleEvent } from '../runtime/orca-runtime'
import { mainProcessState as state } from './main-process-state'

export function emitPluginWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
  // Public worktree events retain their Git-only scope.
  if (parseWorkspaceKey(event.worktreeId)?.type === 'folder') {
    return
  }
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
  // Only shared/ambiguous retained shells may still produce rollout logs needing publication.
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

/** Runs once provider and hook hydration settle, so targeted PTY liveness can answer. */
async function sweepRestoredStatusesAgainstLocalPtys(): Promise<void> {
  const store = state.store
  const provider = getDaemonProvider()
  if (!store || !provider) {
    return
  }
  const persistedPtyIdByPaneKey = indexPersistedPaneKeyPtyIds(
    store.getWorkspaceSession().terminalLayoutsByTabId ?? {}
  )
  await retireRestoredStatusesWithDeadTerminals({
    server: agentHookServer,
    probePtyLiveness: (ptyId) => provider.probePtyLiveness(ptyId),
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
    getPersistedPtyIdForPaneKey: (paneKey) => persistedPtyIdByPaneKey.get(paneKey)
  })
  state.runtime?.agentTransitions.seedRestoredRows()
  await state.runtime?.sidebarFacts?.reconcileSortStampTiers(provider)
}

export function startTerminalRuntimeStartupServices(): WindowsDesktopStartupServices {
  agentHookServer.setTmuxManagedPtyResolver(
    createLocalTmuxManagedPtyResolver({
      getPtyId: getPtyIdForPaneKey,
      listProcesses: async () => (await getDaemonProvider()?.listProcesses()) ?? []
    })
  )
  logStartupMilestone('first-window-startup-services-start')
  const startupServices = startFirstWindowStartupServices({
    // Desktop/serve must adopt the persistent provider before terminals or renderers exist.
    startDaemonPtyProvider: async (signal) => {
      logStartupMilestone('startup-service-start', { service: 'daemon-pty-provider' })
      // Only GUI macOS daemons follow login-session death; serve must survive SSH disconnect.
      await initDaemonPtyProvider(signal, {
        macosLoginSessionWatch: process.platform === 'darwin' && !state.isServeMode,
        // Desktop and serve share one per-machine restore budget (D1 Q1).
        spawnAdmission: resolveTerminalSpawnAdmissionMode()
      })
      await restartLocalTerminalsAfterElevation(signal)
      // Retained shells keep their launch-time Codex home despite routing changes.
      const hasRetainedManagedHostPane = hasRecordedManagedHostCodexPane()
      if (
        state.codexRuntimeHome &&
        (hasRetainedManagedHostPane || hasAnyRecordedLegacyWslCodexPane())
      ) {
        const livePtyIds = await listLiveDaemonPtyIds()
        if (livePtyIds) {
          reconcileCodexPaneAccountsWithLivePtys(livePtyIds)
          const settings = state.store?.getSettings()
          // #16441: retained homes may each need an app-server grant; awaiting N sessions delays first paint, while shells cannot invoke Codex before provider readiness.
          if (hasRetainedManagedHostPane) {
            void reconcileRetainedCodexHookHomes({
              hookService: codexHookService,
              hooksEnabled: isAgentStatusHooksEnabledForAgent(settings, 'codex'),
              runtimeHomePaths: state.codexRuntimeHome.getRetainedHostCodexHookHomePaths(livePtyIds)
            }).catch((error) =>
              console.warn('[codex-hook-service] retained Codex home reconcile failed:', error)
            )
          }
        }
      }
      // Retained shells may invoke Codex as soon as the startup gate opens.
      state.codexRuntimeHome?.reconcileLegacySharedHomeForRetainedPanes()
      logStartupMilestone('startup-service-done', { service: 'daemon-pty-provider' })
    },
    // Restored PTYs need live ORCA_AGENT_HOOK_* endpoint state before reconnecting.
    startAgentHookServer: async () => {
      const settings = state.store?.getSettings()
      logStartupMilestone('startup-service-start', { service: 'agent-hook-server' })
      // #11217: IDS resets of loopback POSTs otherwise silently stale all agent status; log/track transport interference.
      agentHookServer.setTransportInterferenceListener((report) => {
        track('agent_hook_transport_blocked', { count: report.count })
      })
      await agentHookServer.start({
        statusHooksEnabled: isAgentStatusHooksEnabled(settings),
        env: app.isPackaged ? 'production' : 'development',
        // Hooks read this file at invocation to reach the new process after restart; namespace dev worktrees sharing orca-dev.
        userDataPath: app.getPath('userData'),
        endpointNamespace: state.devAgentHookEndpointNamespace
      })
      logStartupMilestone('startup-service-done', { service: 'agent-hook-server' })
    },
    onDaemonError: (error) => {
      // Daemon failure silently loses persistence via local PTY fallback; retain fleet-level diagnostics.
      const reason = error instanceof Error ? error.message : String(error)
      console.error(
        `[daemon] STARTUP FAILED — falling back to local PTYs; terminals will not persist across quit. Reason: ${reason}`
      )
      track('daemon_start_failed', classifyError(error))
    },
    onAgentHookServerError: (error) => {
      // Hook status enriches the sidebar; loopback receiver failure must not block startup.
      console.error('[agent-hooks] Failed to start local hook server:', error)
    }
  })
  void startupServices.firstWindowReady.then(() =>
    logStartupMilestone('first-window-startup-services-ready')
  )
  void startupServices.localPtyReady.then(() => {
    logStartupMilestone('local-pty-startup-ready')
    void sweepRestoredStatusesAgainstLocalPtys().catch((error) =>
      console.warn('[agent-hooks] restored-status dead-terminal sweep failed:', error)
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
