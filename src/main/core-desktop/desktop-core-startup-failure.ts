import type { DesktopCore } from './desktop-core'
import type { Store } from '../persistence/loading-store/store'
import { worktreeRemovalLifetime } from '../workspaces/removal/worktree-removal-lifetime'

/** The profile the core saves into; it stays owned by the composing process until it moves. */
export type DesktopCoreProfile = {
  store: Store | null
  /** Called only after the final save and freeze succeed with removals stopped. */
  releaseAdmission(): void
}

/** Startup failed: save and close the profile without the quit teardown. Core may be partly composed. */
export async function closeDesktopCoreAfterStartupFailure(
  core: DesktopCore,
  profile: DesktopCoreProfile
): Promise<void> {
  try {
    const checkpoint = core.checkpointProfile(profile.store, () => core.runtime?.flushPaneGrids())
    const removalStopping = worktreeRemovalLifetime.close().then(
      () => true,
      (closeError) => {
        console.error(
          '[worktrees] Failed to stop workspace deletion after startup failure:',
          closeError
        )
        return false
      }
    )
    const [removalStopped] = await Promise.all([removalStopping, checkpoint.catch(() => {})])
    try {
      await profile.store?.flushFinalOrThrowAsync()
    } finally {
      await profile.store?.freezeWritesAsync()
    }
    if (removalStopped) {
      profile.releaseAdmission()
    }
  } catch (closeError) {
    console.error(
      '[persistence] Failed to close profile persistence after startup failure:',
      closeError
    )
  }
}
