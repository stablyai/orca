import type { OrcaRuntimeService } from '../orca-runtime'
import type { TerminalCreateOptions } from '../runtime-terminal-contracts'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime-managed-worktree-create-types'
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

// A create someone asked for starts its terminals as theirs; an automation's stay background.
export function wslUserAct(args: { wslUserAct?: true }): { wslUserAct?: true } {
  return args.wslUserAct ? { wslUserAct: true } : {}
}

export function workspaceCreateTerminalFactory(
  runtime: Pick<OrcaRuntimeService, 'createTerminal'>,
  args: RuntimeManagedWorktreeCreateArgs,
  worktree?: Parameters<OrcaRuntimeService['createTerminal']>[2]
) {
  return (selector: string, options: TerminalCreateOptions) =>
    runtime.createTerminal(
      selector,
      {
        ...options,
        ...wslUserAct(args),
        signal: args.signal,
        onPtySpawnDispatched: args.beforeTerminalSpawn
      },
      worktree
    )
}
