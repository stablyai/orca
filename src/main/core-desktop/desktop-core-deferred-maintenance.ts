import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence/loading-store/store'
import { worktreeRemovalLifetime } from '../workspaces/removal/worktree-removal-lifetime'

// Headless serve has no first window; timer fallback must still sweep trash.
export const WORKTREE_TRASH_SWEEP_FALLBACK_MS = 15_000

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
