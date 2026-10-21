import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../../shared/worktree/launch-types'
import type { createRuntimeFolderWorktree } from '../runtime-folder-worktree-create'
import type { startRuntimeLocalWorktreeTerminals } from '../runtime-local-worktree-terminal-startup'

type FolderActivation = Parameters<typeof createRuntimeFolderWorktree>[0]['deps']['activate']
type LocalActivation = Parameters<typeof startRuntimeLocalWorktreeTerminals>[0]['ports']['activate']

type NotifyActivation = (
  repoId: string,
  worktreeId: string,
  setup?: CreateWorktreeResult['setup'],
  startup?: WorktreeStartupLaunch,
  defaultTabs?: CreateWorktreeResult['defaultTabs'],
  navigation?: RuntimeNavigationTarget,
  providesInitialSurface?: boolean
) => void

export function createdWorkspaceActivationCallbacks(
  notify: NotifyActivation,
  navigation?: RuntimeNavigationTarget
): { folder: FolderActivation; local: LocalActivation } {
  const folder: FolderActivation = (repoId, worktreeId, setup, startup, providesInitialSurface) =>
    notify(repoId, worktreeId, setup, startup, undefined, navigation, providesInitialSurface)
  const local: LocalActivation = (
    repoId,
    worktreeId,
    startup,
    failedSetup,
    failedDefaultTabs,
    providesInitialSurface
  ) =>
    notify(
      repoId,
      worktreeId,
      failedSetup,
      startup,
      failedDefaultTabs,
      navigation,
      providesInitialSurface
    )
  return { folder, local }
}
