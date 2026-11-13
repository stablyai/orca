import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/creation/launch-types'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import {
  navigationTargetsClients,
  navigationTargetsHost
} from '../../../../shared/runtime-navigation'
import { toRuntimeActivateWorktreeEvent } from '../../../../shared/runtime-client-events'
import { RuntimeWorkspaceCatalogEvents } from '../catalog/runtime-workspace-catalog-events'

export abstract class RuntimeWorkspaceNavigation extends RuntimeWorkspaceCatalogEvents {
  /** `setup` and `defaultTabs` go to the host window only: main tried and failed to start them. */
  protected notifyActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs'],
    navigationTarget?: RuntimeNavigationTarget,
    providesInitialSurface?: boolean
  ): void {
    const navigation = navigationTarget ?? 'host'
    if (navigationTargetsHost(navigation)) {
      this.notifyHostActivateWorktree(
        repoId,
        worktreeId,
        setup,
        startup,
        defaultTabs,
        providesInitialSurface
      )
    }
    if (navigationTargetsClients(navigation)) {
      this.notifyClientsActivateWorktree(
        repoId,
        worktreeId,
        startup,
        navigation,
        providesInitialSurface
      )
    }
  }

  protected notifyHostActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs'],
    providesInitialSurface?: boolean
  ): void {
    this.notifier?.activateWorktree(
      repoId,
      worktreeId,
      setup,
      startup,
      defaultTabs,
      ...(providesInitialSurface ? ([true] as const) : [])
    )
  }

  protected notifyClientsActivateWorktree(
    repoId: string,
    worktreeId: string,
    startup?: WorktreeStartupLaunch,
    navigation: RuntimeNavigationTarget = 'clients',
    providesInitialSurface?: boolean
  ): void {
    this.emitClientEvent(
      toRuntimeActivateWorktreeEvent(
        repoId,
        worktreeId,
        undefined,
        startup,
        undefined,
        navigation,
        providesInitialSurface
      )
    )
  }
}
