import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  normalizeExecutionHostOrder,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { applyManualRepoOrder } from '../../../shared/manual-repo-order'
import type { DesktopSidebarFacts } from '../../../shared/sidebar-list/desktop-sidebar-facts'
import type { SshConnectionState, SshTarget } from '../../../shared/ssh-types'
import type { WslHostStatus } from '../../../shared/wsl-host-types'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { readAllWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import type { RuntimeStore } from '../runtime-store-contract'
import { runtimeVisibleFolderWorkspaces, runtimeVisibleRepos } from '../runtime-visible-catalog'

export type DesktopSidebarFactSources = {
  store: Pick<
    RuntimeStore,
    | 'getRepos'
    | 'getProjectGroups'
    | 'getFolderWorkspaces'
    | 'getSshTargets'
    | 'getAllWorktreeMeta'
    | 'getAllWorktreeMetaForHost'
  > & {
    getWorkspaceSession?: (
      hostId: ExecutionHostId
    ) => Pick<WorkspaceSessionState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>
    getUI?: () => Pick<PersistedUIState, 'manualRepoOrder' | 'workspaceHostOrder'>
  }
  /** The registry's list, which leaves out targets a paired server owns; the window lists the same. */
  sshTargets: readonly Pick<SshTarget, 'id' | 'label'>[]
  sshStateOf: (targetId: string) => Pick<SshConnectionState, 'status'> | undefined
  /** Empty where WSL hosts cannot exist. */
  wslStatuses: readonly Pick<WslHostStatus, 'environmentId' | 'distro' | 'state'>[]
}

/** Read on demand: every fact already lives in this host's store or connection registries. */
export function readDesktopSidebarFacts(sources: DesktopSidebarFactSources): DesktopSidebarFacts {
  const { store } = sources
  // Global session fields live on the local slice alone (workspace-session-host-field-ownership.ts).
  const session = store.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
  const ui = store.getUI?.()
  const repos = runtimeVisibleRepos(store)
  const repoHostIds = new Set<ExecutionHostId>(repos.map((repo) => getRepoExecutionHostId(repo)))

  const pinned = new Set<string>()
  for (const hostId of repoHostIds) {
    for (const [worktreeId, meta] of Object.entries(readAllWorktreeMetaForHost(store, hostId))) {
      if (meta.isPinned) {
        pinned.add(worktreeId)
      }
    }
  }
  for (const folder of runtimeVisibleFolderWorkspaces(store)) {
    if (folder.isPinned) {
      pinned.add(folderWorkspaceKey(folder.id))
    }
  }

  return {
    desktopActive: {
      hostId: session?.activeWorkspaceExecutionHostId ?? null,
      worktreeId: session?.activeWorktreeId ?? null
    },
    pinnedWorkspaceIds: [...pinned].sort(),
    repoOrder: applyManualRepoOrder(repos, ui?.manualRepoOrder).map((repo) => ({
      hostId: getRepoExecutionHostId(repo),
      repoId: repo.id
    })),
    workspaceHostOrder: normalizeExecutionHostOrder(ui?.workspaceHostOrder),
    sshHosts: Object.fromEntries(
      sources.sshTargets.map((target) => [
        toSshExecutionHostId(target.id),
        { label: target.label, status: sources.sshStateOf(target.id)?.status ?? null }
      ])
    ),
    wslHosts: Object.fromEntries(
      sources.wslStatuses.map((status) => [
        toRuntimeExecutionHostId(status.environmentId),
        { distro: status.distro, state: status.state }
      ])
    )
  }
}
