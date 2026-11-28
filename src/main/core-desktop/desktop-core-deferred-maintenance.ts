import type { DesktopCore } from './desktop-core'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence/loading-store/store'
import { registerLazyIpcHandleGroup } from '../ipc/lazy-ipc-handle-group'
import type { StarNagService } from '../star-nag/service'
import type { WorkspaceCleanupRunner } from '../workspaces/cleanup/workspace-cleanup-runner'
import { registerWorkspaceCleanupRunnerLoader } from '../workspaces/cleanup/workspace-cleanup-runner-registry'
import { worktreeRemovalLifetime } from '../workspaces/removal/worktree-removal-lifetime'

const STAR_NAG_IPC_CHANNELS = [
  'star-nag:dismiss',
  'star-nag:later',
  'star-nag:complete',
  'star-nag:disable',
  'star-nag:openWeb',
  'star-nag:starOrca',
  'star-nag:forceShow',
  'star-nag:agentValueMoment',
  'star-nag:showAgentValueMoment',
  'star-nag:onboardingCompleted'
] as const

// Headless serve has no first window; timer fallback must still sweep trash.
export const WORKTREE_TRASH_SWEEP_FALLBACK_MS = 15_000

export function registerDeferredDesktopCoreServices(
  core: DesktopCore,
  runtime: OrcaRuntimeService,
  store: Store,
  isQuitting: () => boolean,
  providerMaintenanceReady: Promise<void>
): void {
  let cleanupRunnerPromise: Promise<WorkspaceCleanupRunner | null> | null = null
  const ensureCleanupRunner = () =>
    (cleanupRunnerPromise ??= import('../workspaces/cleanup/workspace-cleanup-runner-startup').then(
      ({ startWorkspaceCleanupRunner }) => startWorkspaceCleanupRunner(runtime, store)
    ))
  registerWorkspaceCleanupRunnerLoader(runtime, ensureCleanupRunner)

  let starNagPromise: Promise<StarNagService> | null = null
  const ensureStarNag = () =>
    (starNagPromise ??= import('../star-nag/service').then(({ StarNagService }) => {
      const starNag = new StarNagService(store, core.stats!)
      core.starNag = starNag
      starNag.start()
      return starNag
    }))
  registerLazyIpcHandleGroup(STAR_NAG_IPC_CHANNELS, async (ipc) => {
    const starNag = await ensureStarNag()
    starNag.registerIpcHandlers(ipc)
  })

  void providerMaintenanceReady.then(async () => {
    if (isQuitting()) {
      return
    }
    const [{ scheduleStalePluginGitTempSweep }] = await Promise.all([
      import('../plugins/installation/plugin-git-temp-sweep'),
      ensureCleanupRunner().catch((error: unknown) =>
        console.warn('[workspace-cleanup] deferred startup failed:', error)
      ),
      ensureStarNag().catch((error: unknown) =>
        console.warn('[star-nag] deferred startup failed:', error)
      )
    ])
    if (!isQuitting()) {
      scheduleStalePluginGitTempSweep()
    }
  })
}

export function scheduleDeferredMaintenance(
  runtime: OrcaRuntimeService,
  store: Store,
  deps: {
    paths: { userData: string }
    native: { afterFirstWindowShown(task: () => void, fallbackMs: number): void }
  },
  releaseProviderMaintenance: () => void
): void {
  const { paths, native } = deps
  const afterFirstWindow = (task: () => void): void =>
    native.afterFirstWindowShown(task, WORKTREE_TRASH_SWEEP_FALLBACK_MS)
  // Finish recorded deletes and old trash left across crashes; defer disk sweeps so they do not compete with first paint/catalog hydration.
  afterFirstWindow(() => {
    releaseProviderMaintenance()
    void import('../workspaces/removal/worktree-trash')
      .then(({ collectWorktreeTrashSweepRoots, sweepStaleWorktreeTrash }) =>
        sweepStaleWorktreeTrash(
          collectWorktreeTrashSweepRoots(store.getRepos(), store.getSettings())
        )
      )
      .catch((error) => {
        console.warn('[worktrees] Failed to sweep leftover worktree directories:', error)
      })
    worktreeRemovalLifetime.resume(() => runtime.finishInterruptedWorktreeRemovals())
  })
  // Defer noncritical plugin-file refresh past first paint.
  afterFirstWindow(() => {
    void import('../opencode/status-hooks/opencode-status-plugin-startup-refresh')
      .then(({ refreshInstalledOpenCodeStatusPlugins }) =>
        refreshInstalledOpenCodeStatusPlugins(store.getSettings())
      )
      .catch((error) => console.warn('[opencode] Failed to refresh status plugins:', error))
  })
  afterFirstWindow(() => {
    void import('../telemetry/wsl-usage-reporter')
      .then(({ WslUsageReporter }) => new WslUsageReporter(store, paths.userData).start())
      .catch((error) => console.warn('[telemetry] Failed to start WSL usage reporter:', error))
  })
  // Suspended permission probes left by older builds hold LaunchServices slots until every app launch hangs.
  afterFirstWindow(() => {
    void import('../computer/macos-permissions/macos-permission-status-leftover-reap')
      .then(({ reapLeftoverMacOSPermissionStatusHelpers }) =>
        reapLeftoverMacOSPermissionStatusHelpers()
      )
      .catch((error) => console.warn('[permissions] Failed to reap leftover helpers:', error))
  })
  afterFirstWindow(() => {
    void import('../orcad/artifact-slots/orcad-artifact-cache-retention')
      .then(({ pruneDesktopOrcadArtifactCache }) => pruneDesktopOrcadArtifactCache(paths.userData))
      .catch((error) => {
        console.warn('[orcad-artifacts] Failed to bound the slot cache:', error)
      })
  })
  // The startup pass ran before browser sessions and any window existed, so `browser-cookies` paused.
  afterFirstWindow(() => {
    void import('../persistence/moving-wsl-projects/desktop-state/wsl-move-desktop-rewrite')
      .then(({ runGatedWslMoveDesktopRewritePass }) =>
        runGatedWslMoveDesktopRewritePass({ userDataPath: paths.userData })
      )
      .catch((error) => console.warn('[wsl-move] Failed to run deferred desktop rewrite:', error))
  })
}
